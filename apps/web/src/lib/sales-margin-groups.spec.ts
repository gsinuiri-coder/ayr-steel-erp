import { describe, expect, it } from 'vitest';
import { toDecimal, type SalesMarginOrderDto } from '@ayr/shared';
import {
  groupSalesMargin,
  parseSalesMarginView,
  summarizeSalesMargin,
} from './sales-margin-groups';
import { filterReportRows, marginPctOf, sumDecimal, visibleReportRows } from './report-table';

/** cc32 — «Ver por» de Ventas y margen y la tabla de reporte. */
function order(
  code: string,
  seller: string | null,
  customer: string,
  sales: string,
  cost: string | null,
): SalesMarginOrderDto {
  const margin = cost === null ? null : toDecimal(sales).minus(cost).toFixed(2);
  return {
    salesOrderId: null,
    orderCode: code,
    customerName: customer,
    sellerName: seller,
    salesPen: sales,
    costPen: cost,
    opMaterialCostPen: '0.00',
    marginPen: margin,
    marginPct: margin === null ? null : marginPctOf(toDecimal(sales), toDecimal(margin)),
    costStatus: cost === null ? 'NO_COMPARABLE' : 'COMPLETO',
    inTotals: true,
    documents: [],
  };
}

// Montos con tercios de céntimo en el margen % y un vendedor nulo, para que redondear antes de
// sumar se note.
const ORDERS = [
  order('PED-000061', 'Gabriela R.', 'Constructora Los Álamos S.A.C.', '1455.25', '1020.40'),
  order('PED-000060', 'Marco T.', 'Techos del Sur E.I.R.L.', '7135.59', '5280.34'),
  order('PED-000059', 'Gabriela R.', 'Drywall Norte S.A.C.', '3355.93', '2651.18'),
  order('PED-000058', 'Marco T.', 'Inversiones Rímac S.A.C.', '1822.03', '1603.39'),
  order('PED-000057', null, 'Techos del Sur E.I.R.L.', '0.01', '0.00'),
  order('PED-000056', 'Marco T.', 'Drywall Norte S.A.C.', '333.33', null),
];

describe('Ver por', () => {
  it('la vista de la URL cae a «Pedido» si no es una de las tres', () => {
    expect(parseSalesMarginView('vendedor')).toBe('vendedor');
    expect(parseSalesMarginView('otra')).toBe('pedido');
    expect(parseSalesMarginView('')).toBe('pedido');
  });

  it.each(['vendedor', 'cliente'] as const)(
    'por %s, la suma de los grupos es igual al total del reporte',
    (by) => {
      const total = summarizeSalesMargin(ORDERS);
      const groups = groupSalesMargin(ORDERS, by);
      const sumOf = (pick: (g: (typeof groups)[number]) => string) =>
        groups.reduce((acc, g) => acc.plus(pick(g)), toDecimal('0'));
      expect(sumOf((g) => g.sales.toString()).equals(total.sales)).toBe(true);
      expect(sumOf((g) => g.cost.toString()).equals(total.cost)).toBe(true);
      expect(sumOf((g) => g.margin.toString()).equals(total.margin)).toBe(true);
      expect(groups.reduce((acc, g) => acc + g.count, 0)).toBe(ORDERS.length);
      // Y el total es la suma exacta de las filas.
      expect(total.sales.toFixed(2)).toBe('14102.14');
      expect(total.cost.toFixed(2)).toBe('10555.31');
      expect(total.margin.toFixed(2)).toBe('3213.50');
    },
  );

  it('agrupa por vendedor, con «Sin vendedor» aparte', () => {
    const groups = groupSalesMargin(ORDERS, 'vendedor');
    expect(groups.map((g) => [g.label, g.count])).toEqual([
      ['Gabriela R.', 2],
      ['Marco T.', 3],
      ['Sin vendedor', 1],
    ]);
    const marco = groups.find((g) => g.label === 'Marco T.');
    expect(marco?.sales.toFixed(2)).toBe('9290.95');
    // El pedido sin costo no suma costo ni baja el porcentaje.
    expect(marco?.cost.toFixed(2)).toBe('6883.73');
    // 2,073.89 ÷ 8,957.62: la venta del pedido sin costo (333.33) queda fuera de la base.
    expect(marco?.marginPct).toBe('23.15');
  });

  it('agrupa por cliente por su nombre', () => {
    const groups = groupSalesMargin(ORDERS, 'cliente');
    expect(groups.map((g) => [g.label, g.count])).toEqual([
      ['Constructora Los Álamos S.A.C.', 1],
      ['Techos del Sur E.I.R.L.', 2],
      ['Drywall Norte S.A.C.', 2],
      ['Inversiones Rímac S.A.C.', 1],
    ]);
  });

  it('sin base positiva, el porcentaje se calla', () => {
    expect(summarizeSalesMargin([]).marginPct).toBeNull();
    expect(marginPctOf(toDecimal('-10'), toDecimal('-10'))).toBeNull();
  });
});

describe('tabla de reporte', () => {
  const columns = [
    {
      key: 'order',
      sortValue: { text: (o: SalesMarginOrderDto) => o.orderCode ?? '' },
      searchText: (o: SalesMarginOrderDto) => o.orderCode ?? '',
    },
    {
      key: 'customer',
      sortValue: { text: (o: SalesMarginOrderDto) => o.customerName },
      searchText: (o: SalesMarginOrderDto) => o.customerName,
    },
    { key: 'sales', sortValue: { decimal: (o: SalesMarginOrderDto) => o.salesPen } },
  ];

  it('busca sin acentos ni mayúsculas y por cada palabra', () => {
    expect(filterReportRows(ORDERS, columns, 'alamos').map((o) => o.orderCode)).toEqual([
      'PED-000061',
    ]);
    expect(filterReportRows(ORDERS, columns, 'drywall 59').map((o) => o.orderCode)).toEqual([
      'PED-000059',
    ]);
    expect(filterReportRows(ORDERS, columns, '  ')).toHaveLength(ORDERS.length);
  });

  it('ordena por una columna decimal y por texto', () => {
    const bySales = visibleReportRows(ORDERS, columns, '', { key: 'sales', dir: 'desc' });
    expect(bySales.map((o) => o.orderCode)).toEqual([
      'PED-000060',
      'PED-000059',
      'PED-000058',
      'PED-000061',
      'PED-000056',
      'PED-000057',
    ]);
    const byCode = visibleReportRows(ORDERS, columns, '', { key: 'order', dir: 'asc' });
    expect(byCode[0]?.orderCode).toBe('PED-000056');
    // Una clave que la tabla no declara deja las filas como llegan.
    expect(visibleReportRows(ORDERS, columns, '', { key: 'otra', dir: 'asc' })).toEqual(ORDERS);
  });

  it('suma con los valores completos y redondea al final', () => {
    const thirds = [{ v: '0.333' }, { v: '0.333' }, { v: '0.334' }, { v: null }];
    expect(sumDecimal(thirds, (r) => r.v).toFixed(2)).toBe('1.00');
  });
});
