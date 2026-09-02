import { Decimal, roundTo, toDecimal, type DecimalInput } from '@ayr/shared';

/**
 * Prorrateo de landed cost por kilo (D-043). Reparte `amountPen` entre los ítems según
 * su peso, con el mismo acumulado redondeado del partido para que la suma de las partes
 * sea exactamente el monto imputado y no sobre ni falte un céntimo en el kardex.
 */
export function prorateByWeight(
  amountPen: DecimalInput,
  items: { id: string; qtyKg: DecimalInput }[],
): { id: string; amountPen: Decimal }[] {
  const amount = toDecimal(amountPen);
  const weights = items.map((i) => toDecimal(i.qtyKg));
  const totalKg = weights.reduce((acc, w) => acc.plus(w), new Decimal(0));
  if (totalKg.lte(0)) return [];

  const result: { id: string; amountPen: Decimal }[] = [];
  let cumulativeKg = new Decimal(0);
  let previousAmount = new Decimal(0);
  items.forEach((item, index) => {
    cumulativeKg = cumulativeKg.plus(weights[index] ?? new Decimal(0));
    const cumulativeAmount = roundTo(amount.times(cumulativeKg).div(totalKg), 'MONEY');
    result.push({ id: item.id, amountPen: cumulativeAmount.minus(previousAmount) });
    previousAmount = cumulativeAmount;
  });
  return result;
}
