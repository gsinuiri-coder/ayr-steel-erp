import { BadRequestException } from '@nestjs/common';
import { planCoilCloseAdjustment } from './coil-close-math';

/**
 * D-164 — la aritmética de la liquidación de remanente al cerrar una bobina.
 *
 * Lo que estos casos protegen es que el cierre **no invente ni destruya valor en silencio**:
 * el remanente que sale tiene que salir al promedio con el que entró, el remanente ínfimo no
 * tiene que abrir un movimiento y el conteo que da de más tiene que entrar valorizado aunque
 * el saldo esté en cero.
 */
describe('planCoilCloseAdjustment (D-164)', () => {
  const base = { avgCostPen: '4.2400', documentUnitCostPen: '4.0000' };

  it('liquida como merma el saldo teórico que el rollo agotado dejó', () => {
    const plan = planCoilCloseAdjustment({ ...base, balanceKg: '37.500', physicalKg: '0' });
    expect(plan).not.toBeNull();
    expect(plan?.kind).toBe('SHORTAGE');
    expect(plan?.qtyKg.toFixed(3)).toBe('37.500');
    // Al promedio vigente, que es el mismo con el que el kardex la va a sacar (D-028/D-040).
    expect(plan?.totalCostPen.toFixed(4)).toBe('159.0000');
  });

  it('liquida solo la diferencia cuando el rollo todavía tiene material', () => {
    const plan = planCoilCloseAdjustment({ ...base, balanceKg: '100.000', physicalKg: '92.250' });
    expect(plan?.kind).toBe('SHORTAGE');
    expect(plan?.qtyKg.toFixed(3)).toBe('7.750');
  });

  it('no emite movimiento cuando lo declarado coincide con el saldo', () => {
    // Cerrar sin liquidar sigue siendo legítimo: es sacar de producción un rollo que se
    // guarda. Lo que D-164 cierra es que eso ocurra **por defecto**, no que sea imposible.
    expect(
      planCoilCloseAdjustment({ ...base, balanceKg: '2500.000', physicalKg: '2500.000' }),
    ).toBeNull();
  });

  it('no emite movimiento por un residuo por debajo de la escala de kilos', () => {
    // El caso que rompía el cierre normal: la resta de dos Decimal deja una milésima de más
    // allá de la tercera decimal y `InventoryService.record` rechaza un `qty` de 0.000 con
    // "la cantidad debe ser mayor a cero" — un 400 sobre cantidades que nadie tipeó.
    expect(
      planCoilCloseAdjustment({ ...base, balanceKg: '10.0001', physicalKg: '10.0000' }),
    ).toBeNull();
  });

  it('da de alta el sobrante cuando el conteo físico supera al saldo teórico', () => {
    const plan = planCoilCloseAdjustment({ ...base, balanceKg: '5.000', physicalKg: '12.000' });
    expect(plan?.kind).toBe('SURPLUS');
    expect(plan?.qtyKg.toFixed(3)).toBe('7.000');
    // Con saldo vivo, el promedio vigente es la referencia correcta: la entrada no puede
    // cambiar el costo por kilo de un material que es el mismo.
    expect(plan?.unitCostPen.toFixed(4)).toBe('4.2400');
  });

  it('valoriza el sobrante al costo del documento cuando el saldo está en cero', () => {
    // Sin kilos en stock no hay promedio vigente (queda en cero), y entrar ahí "al promedio"
    // metería kilos sin valor al inventario valorizado.
    const plan = planCoilCloseAdjustment({
      ...base,
      avgCostPen: '0',
      balanceKg: '0',
      physicalKg: '15.000',
    });
    expect(plan?.kind).toBe('SURPLUS');
    expect(plan?.unitCostPen.toFixed(4)).toBe('4.0000');
    expect(plan?.totalCostPen.toFixed(4)).toBe('60.0000');
  });

  it('rechaza kilos declarados negativos', () => {
    expect(() =>
      planCoilCloseAdjustment({ ...base, balanceKg: '10.000', physicalKg: '-1.000' }),
    ).toThrow(BadRequestException);
  });
});
