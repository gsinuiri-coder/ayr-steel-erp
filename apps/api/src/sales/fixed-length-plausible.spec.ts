import {
  fixedLengthMeters,
  fixedLengthUnitValue,
  isPlausiblePieceLength,
  MAX_PIECE_LENGTH_MM,
  MIN_PIECE_LENGTH_MM,
  money,
  salePriceFromValue,
  salesLineTotals,
  saleValueFromPrice,
  sellsByFixedLength,
  toFixedString,
} from '@ayr/shared';
import { BadRequestException } from '@nestjs/common';
import { assertUsableFixedLength } from './sales-lines';

/**
 * D-166 — **el largo del maestro tiene que ser un largo posible antes de multiplicar por él.**
 *
 * El defecto, tal como lo vio el dueño: `PL028ROJO`, una plancha de 3 metros, tenía `3.00` en
 * `products.length_mm` porque el campo del catálogo pide **milímetros** y el resto de la
 * pantalla de coberturas trabaja en **metros**. Diez planchas a S/ 11 el metro salían **S/ 0.28**
 * en vez de S/ 330 — mil veces menos— y no había un solo error por ningún lado: la línea
 * mostraba «0.00» de largo y «0.030 m lineales», dos números que había que saber leer.
 *
 * Las tres planchas del catálogo del dueño estaban así. No es un desliz, es una trampa del
 * campo.
 *
 * Lo que estos casos fijan es que **`sellsByFixedLength` no alcanza**: con `largo > 0` dice que
 * sí y multiplica igual. La pregunta «¿este número se puede creer?» es otra, y tiene que
 * contestarse antes.
 */
describe('D-166 — el largo fijo de una plancha tiene que ser posible', () => {
  /** El caso exacto de la captura: 10 planchas de 3 m a S/ 11 el metro, con IGV. */
  const CAPTURA = { lengthMm: '3000.00', qty: '10', pricePerMeterPen: '11' };

  it('el caso de la captura, con el largo bien cargado, da S/ 330 con IGV', () => {
    const valuePerMeter = money(saleValueFromPrice(CAPTURA.pricePerMeterPen));
    const unitValue = money(fixedLengthUnitValue(CAPTURA.lengthMm, valuePerMeter));
    const totals = salesLineTotals({
      qty: CAPTURA.qty,
      unitPricePen: toFixedString(unitValue, 'MONEY'),
    });

    // 3 m × S/ 11/m = S/ 33 por plancha (con IGV), × 10 = S/ 330.
    expect(salePriceFromValue(unitValue).toFixed(2)).toBe('33.00');
    expect(salePriceFromValue(totals.subtotal).toFixed(2)).toBe('330.00');
    expect(fixedLengthMeters(CAPTURA.lengthMm, CAPTURA.qty).toFixed(3)).toBe('30.000');
  });

  it('con el largo en metros —el defecto— la línea salía mil veces más barata', () => {
    // Es el número de la captura, y está acá para que se vea de dónde salía: no es un caso
    // que el sistema deba soportar, es el que ahora se rechaza.
    const valuePerMeter = money(saleValueFromPrice(CAPTURA.pricePerMeterPen));
    const unitValue = money(fixedLengthUnitValue('3.00', valuePerMeter));
    const totals = salesLineTotals({
      qty: CAPTURA.qty,
      unitPricePen: toFixedString(unitValue, 'MONEY'),
    });

    expect(fixedLengthMeters('3.00', CAPTURA.qty).toFixed(3)).toBe('0.030');
    expect(totals.subtotal.toFixed(2)).toBe('0.28');
    // Y el peligro es exactamente este: `sellsByFixedLength` decía que sí.
    expect(sellsByFixedLength({ roofingKind: 'PLANCHA', unit: 'NIU', lengthMm: '3.00' })).toBe(
      true,
    );
  });

  it('`isPlausiblePieceLength` separa el largo en metros del largo en milímetros', () => {
    // Los tres largos que tenía el catálogo del dueño.
    expect(isPlausiblePieceLength('3.00')).toBe(false);
    expect(isPlausiblePieceLength('6.00')).toBe(false);
    // Los mismos, bien cargados.
    expect(isPlausiblePieceLength('3000.00')).toBe(true);
    expect(isPlausiblePieceLength('6000.00')).toBe(true);
  });

  it('los bordes del rango entran, y un milímetro afuera no', () => {
    expect(isPlausiblePieceLength(String(MIN_PIECE_LENGTH_MM))).toBe(true);
    expect(isPlausiblePieceLength(String(MIN_PIECE_LENGTH_MM - 1))).toBe(false);
    expect(isPlausiblePieceLength(String(MAX_PIECE_LENGTH_MM))).toBe(true);
    expect(isPlausiblePieceLength(String(MAX_PIECE_LENGTH_MM + 1))).toBe(false);
  });

  it('es una pregunta DISTINTA de `sellsByFixedLength`, y por eso hacen falta las dos', () => {
    // El centinela de la familia de D-131 vive en `sales-lines.spec.ts`; este cubre el par que
    // D-166 agregó. Las dos devuelven `boolean` sobre el mismo campo y dan lo contrario
    // justamente en el caso que rompió, que es cuando el compilador no ayuda.
    const rota = { roofingKind: 'PLANCHA', unit: 'NIU', lengthMm: '3.00' };
    expect(sellsByFixedLength(rota)).toBe(true);
    expect(isPlausiblePieceLength(rota.lengthMm)).toBe(false);
    expect(sellsByFixedLength(rota)).not.toBe(isPlausiblePieceLength(rota.lengthMm));

    // Y sobre un largo bien cargado las dos dicen que sí: no son la misma pregunta, pero
    // tampoco son opuestas — confundirlas por el caso feliz es el error que se busca evitar.
    const sana = { roofingKind: 'PLANCHA', unit: 'NIU', lengthMm: '3000.00' };
    expect(sellsByFixedLength(sana)).toBe(true);
    expect(isPlausiblePieceLength(sana.lengthMm)).toBe(true);
  });
});

/**
 * El corte que protege a los productos **ya guardados** con el largo roto. Es el único camino
 * por el que hoy se llega a uno: desde D-166 el catálogo no los deja crear ni editar así, y
 * por eso este caso vive acá y no en E2E — montarlo por la app es imposible a propósito.
 */
describe('assertUsableFixedLength (D-166)', () => {
  const plancha = { sku: 'PL028ROJO', roofingKind: 'PLANCHA', unit: 'NIU' };

  it('corta la línea con el SKU nombrado y explica la unidad', () => {
    expect(() => {
      assertUsableFixedLength(plancha, '3.00', 'Línea 1');
    }).toThrow(BadRequestException);

    try {
      assertUsableFixedLength(plancha, '3.00', 'Línea 1');
      throw new Error('tenía que cortar');
    } catch (err) {
      const message = (err as BadRequestException).message;
      expect(message).toContain('Línea 1');
      expect(message).toContain('PL028ROJO');
      // El número traducido y la unidad: sin los dos, el vendedor no sabe qué corregir.
      expect(message).toContain('0.003 m');
      expect(message).toContain('milímetros');
      expect(message).toContain('3000');
    }
  });

  it('deja pasar el largo bien cargado', () => {
    expect(() => {
      assertUsableFixedLength(plancha, '3000.00', 'Línea 1');
    }).not.toThrow();
  });

  it('no se mete con lo que no es una plancha de catálogo', () => {
    // Una cobertura a medida no tiene largo propio (D-127) y sus largos van por subítem, que
    // ya tienen su propia validación de rango desde antes.
    expect(() => {
      assertUsableFixedLength(
        { ...plancha, roofingKind: 'A_MEDIDA', unit: 'MTR' },
        null,
        'Línea 1',
      );
    }).not.toThrow();
    // Una plancha legada en KGM no multiplica por el largo (D-161 exige `NIU`), así que su
    // largo raro no puede producir el defecto y bloquearla sería romper una venta que anda.
    expect(() => {
      assertUsableFixedLength({ ...plancha, unit: 'KGM' }, '3.00', 'Línea 1');
    }).not.toThrow();
    // Y un producto sin largo cae en el camino viejo, que es lo que D-161 ya decidía.
    expect(() => {
      assertUsableFixedLength(plancha, null, 'Línea 1');
    }).not.toThrow();
  });
});
