import { BadRequestException } from '@nestjs/common';
import { Decimal } from '@ayr/shared';
import { expandSplitWidths, planCoilSplit } from './coil-split-math';

/** Suma los pesos de las hijas de un plan, para verificar que el reparto cierra. */
function childrenTotal(children: { weightKg: Decimal }[]): Decimal {
  return children.reduce((acc, c) => acc.plus(c.weightKg), new Decimal(0));
}

describe('planCoilSplit (RF-15)', () => {
  const base = {
    parentWidthMm: '1220.00',
    availableKg: '5000.000',
    kerfLossMm: '0.00',
  };

  describe('prorrateo de peso por ancho', () => {
    it('reparte el peso en proporción al ancho de cada hija', () => {
      const plan = planCoilSplit({ ...base, widthsMm: ['600.00', '400.00', '220.00'] });

      // 5000 kg sobre 1220 mm: 600/1220, 400/1220 y 220/1220. El reparto por acumulado
      // deja el residuo de redondeo en la hija que toca, no repartido en todas.
      expect(plan.children.map((c) => c.weightKg.toFixed(3))).toEqual([
        '2459.016',
        '1639.345',
        '901.639',
      ]);
      expect(childrenTotal(plan.children).toFixed(3)).toBe('5000.000');
      expect(plan.kerfLossKg.toFixed(3)).toBe('0.000');
    });

    it('la merma de corte se lleva su parte del peso y la suma cierra igual', () => {
      const plan = planCoilSplit({
        ...base,
        kerfLossMm: '20.00',
        widthsMm: ['600.00', '600.00'],
      });

      // Consumido: 600 + 600 + 20 = 1220 mm. Cada hija: 5000 × 600/1220.
      expect(plan.children.map((c) => c.weightKg.toFixed(3))).toEqual(['2459.016', '2459.017']);
      expect(plan.kerfLossKg.toFixed(3)).toBe('81.967');
      expect(childrenTotal(plan.children).plus(plan.kerfLossKg).toFixed(3)).toBe('5000.000');
    });

    it('parte solo el peso pedido y no todo el saldo', () => {
      const plan = planCoilSplit({
        ...base,
        splitWeightKg: '1200.000',
        widthsMm: ['610.00', '610.00'],
      });

      expect(plan.splitWeightKg.toFixed(3)).toBe('1200.000');
      expect(plan.children.map((c) => c.weightKg.toFixed(3))).toEqual(['600.000', '600.000']);
    });

    it('sin peso explícito parte todo el saldo disponible del kardex', () => {
      const plan = planCoilSplit({ ...base, availableKg: '3210.500', widthsMm: ['1220.00'] });
      expect(plan.splitWeightKg.toFixed(3)).toBe('3210.500');
      expect(plan.children[0]?.weightKg.toFixed(3)).toBe('3210.500');
    });

    it('expande varias tiras iguales en una entrada por hija', () => {
      expect(
        expandSplitWidths([
          { widthMm: '100.00', count: 3 },
          { widthMm: '250.00', count: 1 },
        ]),
      ).toEqual(['100.00', '100.00', '100.00', '250.00']);
    });
  });

  describe('validación de anchos', () => {
    it('rechaza que los anchos más la merma superen el ancho de la madre', () => {
      expect(() =>
        planCoilSplit({ ...base, kerfLossMm: '10.00', widthsMm: ['700.00', '520.00'] }),
      ).toThrow(BadRequestException);
    });

    it('acepta que los anchos sumen exactamente el ancho de la madre', () => {
      const plan = planCoilSplit({ ...base, kerfLossMm: '20.00', widthsMm: ['1200.00'] });
      expect(plan.consumedWidthMm.toFixed(2)).toBe('1220.00');
    });

    it('rechaza partir más kilos de los disponibles', () => {
      expect(() =>
        planCoilSplit({ ...base, splitWeightKg: '5000.001', widthsMm: ['1220.00'] }),
      ).toThrow(BadRequestException);
    });

    it('rechaza una bobina sin kilos disponibles', () => {
      expect(() => planCoilSplit({ ...base, availableKg: '0.000', widthsMm: ['600.00'] })).toThrow(
        BadRequestException,
      );
    });

    it('rechaza un partido sin hijas y uno con merma negativa', () => {
      expect(() => planCoilSplit({ ...base, widthsMm: [] })).toThrow(BadRequestException);
      expect(() => planCoilSplit({ ...base, kerfLossMm: '-1.00', widthsMm: ['600.00'] })).toThrow(
        BadRequestException,
      );
    });

    it('rechaza una hija cuyo peso redondea a cero', () => {
      expect(() =>
        planCoilSplit({
          ...base,
          availableKg: '0.010',
          splitWeightKg: '0.010',
          widthsMm: ['1219.00', '1.00'],
        }),
      ).toThrow(BadRequestException);
    });
  });
});
