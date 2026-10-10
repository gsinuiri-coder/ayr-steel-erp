import type {
  CoilMonthReportDto,
  CoilMonthReportRowDto,
  ProductionSummaryDto,
  ProductionSummaryOrderDto,
  ReceivablesAgingCustomerDto,
  ReceivablesAgingDto,
  SalesByMaterialDto,
  SalesMaterialRowDto,
} from '@ayr/shared';
import {
  searchCoilMonth,
  searchProduction,
  searchReceivables,
  searchSalesByMaterial,
} from './report-xlsx-search';

/**
 * cc40 (D-588): la búsqueda recorta el DTO como la pantalla recorta la tabla, y los totales que la
 * pantalla recalcula al pie se recalculan igual. Sin búsqueda, el DTO no cambia.
 */
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function op(code: string, order: string | null, theoretical: string, consumed: string) {
  const o: ProductionSummaryOrderDto = {
    productionOrderId: uuid(Number(code.slice(-3))),
    code,
    status: 'CLOSED',
    salesOrderId: order === null ? null : uuid(900 + Number(order.slice(-3))),
    salesOrderCode: order,
    lineNumber: order === null ? null : 1,
    productId: uuid(500),
    productSku: `SKU-${code}`,
    productName: `Calamina ${code}`,
    quantity: '10',
    quantityUnit: 'm',
    reportCount: 1,
    theoreticalKg: theoretical,
    consumedKg: consumed,
    trimKg: '0.000',
    wastePct: null,
    overStandard: false,
    materialCostPen: '10.0000',
    trimCostPen: '0.0000',
    coils: [{ coilId: uuid(700), code: `BOB-${code}`, consumedKg: consumed, trimKg: '0.000' }],
  };
  return o;
}

const figures = {
  theoreticalKg: '0',
  consumedKg: '0',
  trimKg: '0',
  wastePct: null,
  overStandard: false,
  materialCostPen: '0',
  trimCostPen: '0',
};

const production: ProductionSummaryDto = {
  from: '2026-10-01',
  to: '2026-10-09',
  businessLine: 'metallic-roofing',
  standardPct: '1.00',
  withCosts: true,
  groups: [
    {
      salesOrderId: uuid(901),
      salesOrderCode: 'PED-000001',
      orders: [
        op('OP-000001', 'PED-000001', '100.000', '101.000'),
        op('OP-000002', 'PED-000001', '50.000', '50.000'),
      ],
      subtotal: { ...figures, theoreticalKg: '150.000', consumedKg: '151.000' },
    },
    {
      salesOrderId: null,
      salesOrderCode: null,
      orders: [op('OP-000003', null, '20.000', '20.000')],
      subtotal: { ...figures, theoreticalKg: '20.000', consumedKg: '20.000' },
    },
  ],
  totals: {
    orderCount: 3,
    ...figures,
    theoreticalKg: '170.000',
    consumedKg: '171.000',
    unattributedKg: '5.000',
  },
};

describe('searchProduction', () => {
  it('sin búsqueda devuelve el mismo DTO', () => {
    expect(searchProduction(production, '  ')).toBe(production);
  });

  it('por orden: las órdenes que coinciden, con el subtotal de su pedido recalculado', () => {
    const out = searchProduction(production, 'op-000002', 'orden');
    expect(out.groups).toHaveLength(1);
    expect(out.groups[0]?.orders.map((o) => o.code)).toEqual(['OP-000002']);
    expect(out.groups[0]?.subtotal.theoreticalKg).toBe('50');
    expect(out.totals.orderCount).toBe(1);
    expect(out.totals.consumedKg).toBe('50');
    expect(out.totals.materialCostPen).toBe('10');
    // Lo salido sin reporte de planta no es de ninguna fila: con búsqueda no suma.
    expect(out.totals.unattributedKg).toBe('0');
  });

  it('por orden, «sin pedido» encuentra las corridas a stock, como la pantalla', () => {
    const out = searchProduction(production, 'sin pedido', 'orden');
    expect(out.groups.map((g) => g.salesOrderCode)).toEqual([null]);
  });

  it('por pedido: el pedido entero, con su subtotal del API', () => {
    const out = searchProduction(production, 'OP-000002', 'pedido');
    expect(out.groups).toHaveLength(1);
    expect(out.groups[0]?.orders).toHaveLength(2);
    expect(out.groups[0]?.subtotal).toBe(production.groups[0]?.subtotal);
    expect(out.totals.orderCount).toBe(2);
    expect(out.totals.theoreticalKg).toBe('150');
  });

  it('la búsqueda no distingue tildes ni mayúsculas', () => {
    expect(searchProduction(production, 'CALAMINA op-000003').groups).toHaveLength(1);
  });
});

function coil(code: string, closing: string, value: string | null): CoilMonthReportRowDto {
  return {
    id: uuid(Number(code.slice(-2))),
    code,
    typeKey: 'BOB-0.30',
    businessLine: 'metallic-roofing',
    colorName: 'Rojo',
    finishName: 'Prepintado',
    widthMm: '1200.00',
    openingKg: closing,
    weightKg: '0.000',
    closingKg: closing,
    unitCostPerKg: value === null ? null : '4.0000',
    closingValuePen: value,
    status: 'OPEN',
  } as CoilMonthReportRowDto;
}

describe('searchCoilMonth', () => {
  const report = {
    month: '2026-10',
    businessLine: null,
    sealed: {
      rows: [coil('BOB-01', '100.000', '400.0000'), coil('BOB-02', '50.000', '200.0000')],
      totals: { openingKg: '150', weightKg: '0', closingKg: '150', closingValuePen: '600' },
    },
    opened: {
      rows: [coil('BOB-03', '10.000', '40.0000')],
      totals: { openingKg: '10', weightKg: '0', closingKg: '10', closingValuePen: '40' },
    },
  } as unknown as CoilMonthReportDto;

  it('recorta las dos tablas y recalcula su subtotal; el estado también se busca', () => {
    const out = searchCoilMonth(report, 'bob-02');
    expect(out.sealed.rows.map((r) => r.code)).toEqual(['BOB-02']);
    expect(out.sealed.totals).toEqual({
      openingKg: '50',
      weightKg: '0',
      closingKg: '50',
      closingValuePen: '200',
    });
    expect(out.opened.rows).toEqual([]);
    expect(searchCoilMonth(report, 'abierta').opened.rows.map((r) => r.code)).toEqual(['BOB-03']);
  });

  it('el rol que no ve costos sigue sin valor aunque la búsqueda no deje filas', () => {
    const masked = {
      ...report,
      opened: { rows: [], totals: { ...report.opened.totals, closingValuePen: null } },
    } as CoilMonthReportDto;
    expect(searchCoilMonth(masked, 'nada').opened.totals.closingValuePen).toBeNull();
  });
});

describe('searchReceivables', () => {
  const customer = (name: string, doc: string, balance: string) =>
    ({
      customerId: uuid(Number(doc.slice(-2))),
      customerName: name,
      customerDocNumber: doc,
      documentCount: 1,
      balancePen: balance,
      buckets: { CURRENT: balance, D1_30: '0', D31_60: '0', D61_90: '0', OVER_90: '0' },
      documents: [{ number: 'F001-1', salesOrderCode: 'PED-000001', sellerName: 'Ana' }],
    }) as unknown as ReceivablesAgingCustomerDto;
  const report = {
    asOf: '2026-10-09',
    sellerId: null,
    sellers: [],
    customers: [
      customer('Álamos S.A.C.', '20100000011', '100.5000'),
      customer('Rímac', '20100000012', '20'),
    ],
    totals: { balancePen: '120.5', buckets: {}, documentCount: 2, customerCount: 2 },
  } as unknown as ReceivablesAgingDto;

  it('los clientes que coinciden y su total', () => {
    const out = searchReceivables(report, 'alamos');
    expect(out.customers.map((c) => c.customerName)).toEqual(['Álamos S.A.C.']);
    expect(out.totals.balancePen).toBe('100.5');
    expect(out.totals.buckets.CURRENT).toBe('100.5');
    expect(out.totals.customerCount).toBe(1);
    expect(out.totals.documentCount).toBe(1);
  });
});

describe('searchSalesByMaterial', () => {
  const row = (kind: SalesMaterialRowDto['kind'], color: string, sales: string) =>
    ({
      kind,
      thicknessMm: '0.30',
      colorLabel: color,
      lineCount: 1,
      coils: [],
      metersSold: '10',
      theoreticalKg: '30',
      realKg: '30',
      yieldKg: '0',
      yieldPct: '0',
      salesPen: sales,
      costPen: '50',
      profitPen: '0',
      costPerKgPen: null,
      pricePerKgPen: null,
      marginPerKgPen: null,
      pricePerMeterPen: null,
      costPerMeterPen: null,
      marginPerMeterPen: null,
      unit: 'MTR',
      qty: '10',
      costPerUnitPen: null,
    }) as SalesMaterialRowDto;

  it('por material: el subtotal de cada tipo y el total salen de las filas que quedan', () => {
    const report = {
      products: null,
      rows: [
        row('COBERTURA', 'Rojo', '100'),
        row('COBERTURA', 'Azul', '200'),
        row('ACCESORIO', 'Rojo', '40'),
      ],
      subtotals: [
        { ...row('COBERTURA', '', '300'), kind: 'COBERTURA' },
        { ...row('ACCESORIO', '', '40'), kind: 'ACCESORIO' },
      ],
      total: row('COBERTURA', '', '340'),
    } as unknown as SalesByMaterialDto;
    const out = searchSalesByMaterial(report, 'azul');
    expect(out.rows.map((r) => r.colorLabel)).toEqual(['Azul']);
    expect(out.subtotals.map((s) => [s.kind, s.salesPen])).toEqual([['COBERTURA', '200']]);
    expect(out.total.salesPen).toBe('200');
  });

  it('por producto: los productos que coinciden y su total', () => {
    const report = {
      products: {
        rows: [
          { sku: 'UPVC-1', name: 'Teja', salesPen: '10', costPen: '4', profitPen: '6' },
          { sku: 'UPVC-2', name: 'Cumbrera', salesPen: '5', costPen: '1', profitPen: '4' },
        ],
        total: { salesPen: '15', costPen: '5', profitPen: '10' },
        untraceable: [],
      },
    } as unknown as SalesByMaterialDto;
    const out = searchSalesByMaterial(report, 'cumbrera');
    expect(out.products?.rows.map((r) => r.sku)).toEqual(['UPVC-2']);
    expect(out.products?.total).toEqual({ salesPen: '5', costPen: '1', profitPen: '4' });
  });
});
