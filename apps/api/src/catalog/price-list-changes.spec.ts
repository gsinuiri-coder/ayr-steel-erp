import { priceListValueChanged } from './price-list-changes';

/**
 * D-217/M1a: qué cuenta como "cambió de verdad". Dos representaciones del mismo número
 * («7.5» y «7.5000») no son un cambio — si lo fueran, cada `catalog.update()` que no toca el
 * precio pero sí reenvía el mismo valor con otra escala escribiría un renglón de historial
 * vacío de contenido.
 */
describe('priceListValueChanged (D-217)', () => {
  it('sin precio antes y un precio nuevo: cambió', () => {
    expect(priceListValueChanged(null, '10.0000')).toBe(true);
  });

  it('con precio antes y sin precio ahora (se quita): cambió', () => {
    expect(priceListValueChanged('10.0000', null)).toBe(true);
  });

  it('sin precio antes y sin precio ahora: no cambió', () => {
    expect(priceListValueChanged(null, null)).toBe(false);
  });

  it('mismo valor, distinta escala como string: no cambió', () => {
    expect(priceListValueChanged('7.5', '7.5000')).toBe(false);
  });

  it('valor distinto: cambió', () => {
    expect(priceListValueChanged('7.5000', '7.5001')).toBe(true);
  });
});
