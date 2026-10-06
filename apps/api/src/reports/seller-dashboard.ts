import {
  Decimal,
  FiscalDocType,
  toDecimal,
  toFixedString,
  type SellerDashboardDto,
} from '@ayr/shared';

/** Una fila del `groupBy` por tipo: cuántos comprobantes y la suma de su valor sin IGV. */
export interface SellerSalesGroup {
  docType: string;
  count: number;
  subtotalPen: string | null;
}

/**
 * cc27 (M4, D-457): arma el Panel del vendedor con lo que leyó el servicio. Las notas de crédito
 * restan, como en el reporte de ventas y margen; la conversión es «convertidas ÷ emitidas» con un
 * decimal, y sin cotizaciones en el mes no hay porcentaje (un 0 % diría que no convirtió nada).
 */
export function assembleSellerDashboard(input: {
  month: { from: string; to: string };
  sales: readonly SellerSalesGroup[];
  quotationsIssued: number;
  quotationsConverted: number;
}): SellerDashboardDto {
  const salesPen = input.sales.reduce((acc, g) => {
    const amount = toDecimal(g.subtotalPen ?? '0');
    return g.docType === FiscalDocType.NOTA_CREDITO ? acc.minus(amount) : acc.plus(amount);
  }, new Decimal(0));
  return {
    month: input.month,
    salesPen: toFixedString(salesPen, 'MONEY'),
    documentCount: input.sales.reduce((acc, g) => acc + g.count, 0),
    quotationsIssued: input.quotationsIssued,
    quotationsConverted: input.quotationsConverted,
    conversionPct:
      input.quotationsIssued === 0
        ? null
        : new Decimal(input.quotationsConverted)
            .div(input.quotationsIssued)
            .times(100)
            .toDecimalPlaces(1, Decimal.ROUND_HALF_UP)
            .toFixed(1),
  };
}
