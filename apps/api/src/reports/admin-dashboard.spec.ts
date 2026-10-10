import {
  BusinessLine,
  dashboardMonthRanges,
  Decimal,
  type CoilWasteDto,
  type InventoryValuationDto,
  type ReceivablesAgingDto,
  type SalesMarginDto,
} from '@ayr/shared';
import { assembleAdminDashboard } from './admin-dashboard';
import { AdminDashboardService } from './admin-dashboard.service';
import type { CoilWasteService } from './coil-waste.service';
import type { InventoryValuationService } from './inventory-valuation.service';
import type { ReceivablesAgingService } from './receivables-aging.service';
import type { SalesMarginService } from './sales-margin.service';

/**
 * cc26 (D-440, M4). El Panel del administrador no calcula: cada cifra es el campo de su reporte
 * para el mismo rango. Lo que se fija aquí es que eso se cumple campo por campo, que cada reporte
 * se lee una sola vez por rango (el presupuesto de consultas del Panel es la suma de los suyos) y
 * que el rango del Panel es el que su enlace lleva.
 */

const ORDER_ID = '00000000-0000-4000-8000-000000000001';
const docOf = (id: string, issueDate: string, salesPen: string, docType = 'FACTURA') => ({
  id: `00000000-0000-4000-9000-00000000000${id}`,
  number: `F001-${id}`,
  docType: docType as SalesMarginDto['orders'][number]['documents'][number]['docType'],
  status: 'ACCEPTED' as const,
  origin: 'NATIVE' as SalesMarginDto['orders'][number]['documents'][number]['origin'],
  issueDate,
  salesPen,
  costPen: null,
  marginPen: null,
  marginPct: null,
});

function order(over: Partial<SalesMarginDto['orders'][number]>): SalesMarginDto['orders'][number] {
  return {
    salesOrderId: ORDER_ID,
    orderCode: 'PED-0001',
    customerId: '00000000-0000-4000-a000-0000000000c1',
    customerName: 'Cliente',
    customerDocNumber: '20100000001',
    sellerId: '00000000-0000-4000-a000-0000000000d1',
    sellerName: 'Vendedor',
    salesPen: '0.0000',
    costPen: null,
    opMaterialCostPen: '0.0000',
    marginPen: null,
    marginPct: null,
    costStatus: 'COMPLETO',
    inTotals: true,
    documents: [],
    ...over,
  };
}

// Un pedido en los totales (dos comprobantes y una nota de crédito) y otro fuera por su costo.
const SALES_CURRENT: SalesMarginDto = {
  from: '2026-10-01',
  to: '2026-10-06',
  orders: [
    order({
      salesPen: '900.0000',
      documents: [
        docOf('1', '2026-10-02', '600.0000'),
        docOf('2', '2026-10-05', '400.0000'),
        docOf('3', '2026-10-05', '-100.0000', 'NOTA_CREDITO'),
      ],
    }),
    order({
      salesPen: '250.0000',
      costStatus: 'NO_COMPARABLE',
      inTotals: false,
      documents: [docOf('4', '2026-10-02', '250.0000')],
    }),
  ],
  totalsByLine: [
    {
      businessLine: BusinessLine.METALLIC_ROOFING,
      salesPen: '900.0000',
      costPen: '600.0000',
      marginPen: '300.0000',
      marginPct: '33.33',
    },
  ],
  totals: {
    salesPen: '900.0000',
    noCostSalesPen: '0.0000',
    costPen: '600.0000',
    marginPen: '300.0000',
    marginPct: '33.33',
    partialOrderCount: 0,
    excludedOrderCount: 1,
    excludedSalesPen: '250.0000',
    untraceableOrderCount: 0,
    untraceableSalesPen: '0.0000',
    roundingPen: '0.0000',
  },
};

const SALES_PREVIOUS: SalesMarginDto = {
  ...SALES_CURRENT,
  from: '2026-09-01',
  to: '2026-09-06',
  orders: [],
  totals: { ...SALES_CURRENT.totals, salesPen: '700.0000' },
};

const BUCKETS = {
  CURRENT: '100.0000',
  D1_30: '50.5000',
  D31_60: '25.2500',
  D61_90: '0.0000',
  OVER_90: '10.0000',
};
const RECEIVABLES: ReceivablesAgingDto = {
  asOf: '2026-10-06',
  sellerId: null,
  sellers: [],
  customers: [],
  totals: { balancePen: '185.7500', buckets: BUCKETS, documentCount: 4, customerCount: 2 },
};

const INVENTORY: InventoryValuationDto = {
  asOf: '2026-10-06',
  coilGroups: [],
  products: [],
  totalsByLine: [],
  totals: {
    coilValuePen: '1000.0000',
    coilQtyKg: '500.000',
    productValuePen: '250.0000',
    totalValuePen: '1250.0000',
  },
};

/** `'x'`: producción marcada sin reporte; otro texto: marcada, con ese id de reporte (D-465). */
function waste(
  businessLine: CoilWasteDto['businessLine'],
  flags: (null | string)[][],
): CoilWasteDto {
  return {
    from: '2026-10-01',
    to: '2026-10-06',
    businessLine,
    standardPct: '1.00',
    rows: flags.map((productions, i) => ({
      coilId: `00000000-0000-4000-a000-00000000000${i}`,
      code: `B-${i}`,
      kind: 'COIL',
      typeKey: 'x',
      finishName: 'x',
      colorName: null,
      widthMm: '1200.00',
      status: 'OPEN',
      consumedKg: '0.000',
      theoreticalKg: null,
      differenceKg: null,
      trimKg: '0.000',
      closeAdjustmentKg: '0.000',
      wasteKg: null,
      wastePct: null,
      overStandard: false,
      manualScrapKg: '0.000',
      productions: productions.map((f) => ({
        reportId: f === null || f === 'x' ? null : f,
        productionOrderId: null,
        productionOrderCode: null,
        operationDate: '2026-10-02',
        consumedKg: '0.000',
        theoreticalKg: null,
        missingTheoretical: null,
        outOfTolerance: f === null ? null : { label: 'Fuera de tolerancia', excessPct: '2.00' },
      })),
    })),
    totals: {} as CoilWasteDto['totals'],
  };
}

const WASTE = [
  waste(BusinessLine.METALLIC_ROOFING, [['x', null, 'x'], [null], ['x']]),
  // Un reporte de drywall que salió de dos flejes aparece en la fila de cada uno: cuenta una vez.
  waste(BusinessLine.DRYWALL, [['r-1'], ['r-1', 'r-2']]),
];

const RANGES = dashboardMonthRanges('2026-10-06');

function assemble() {
  return assembleAdminDashboard({
    asOf: '2026-10-06',
    current: RANGES.current,
    previous: RANGES.previous,
    salesCurrent: SALES_CURRENT,
    salesPrevious: SALES_PREVIOUS,
    receivables: RECEIVABLES,
    inventory: INVENTORY,
    waste: WASTE,
  });
}

describe('dashboardMonthRanges (D-443)', () => {
  it('compara el mes en curso con el mismo tramo del mes anterior', () => {
    expect(dashboardMonthRanges('2026-10-06')).toEqual({
      current: { from: '2026-10-01', to: '2026-10-06' },
      previous: { from: '2026-09-01', to: '2026-09-06' },
      previousMonth: { from: '2026-09-01', to: '2026-09-30' },
    });
  });

  it('si el mes anterior es más corto, el tramo llega a su último día', () => {
    expect(dashboardMonthRanges('2026-03-31').previous).toEqual({
      from: '2026-02-01',
      to: '2026-02-28',
    });
    expect(dashboardMonthRanges('2028-03-30').previous.to).toBe('2028-02-29');
  });

  it('enero mira diciembre del año anterior', () => {
    expect(dashboardMonthRanges('2027-01-15').previous).toEqual({
      from: '2026-12-01',
      to: '2026-12-15',
    });
  });
});

describe('assembleAdminDashboard (D-440)', () => {
  it('cada cifra de ventas y margen es el campo del reporte, tal cual', () => {
    const d = assemble();
    // cc28 (D-461): el redondeo de comprobantes es del reporte, no del Panel.
    const { roundingPen: _rounding, ...salesTotals } = SALES_CURRENT.totals;
    expect(d.sales).toEqual(salesTotals);
    expect(d.previousSalesPen).toBe(SALES_PREVIOUS.totals.salesPen);
    expect(d.salesByLine).toEqual(
      SALES_CURRENT.totalsByLine.map(({ costPen: _c, ...rest }) => rest),
    );
  });

  it('lo facturado por día suma la venta del reporte más la de los pedidos fuera de los totales (D-444)', () => {
    const d = assemble();
    expect(d.salesByDay).toEqual([
      { date: '2026-10-02', salesPen: '850.0000' },
      { date: '2026-10-05', salesPen: '300.0000' },
    ]);
    const sum = d.salesByDay.reduce((a, r) => a.plus(r.salesPen), new Decimal(0));
    const t = SALES_CURRENT.totals;
    expect(
      sum.equals(new Decimal(t.salesPen).plus(t.excludedSalesPen).plus(t.untraceableSalesPen)),
    ).toBe(true);
  });

  it('CxC: total, tramos y conteos del reporte; lo vencido es la suma de sus tramos vencidos', () => {
    const d = assemble();
    expect(d.receivables.balancePen).toBe(RECEIVABLES.totals.balancePen);
    expect(d.receivables.buckets).toEqual(RECEIVABLES.totals.buckets);
    expect(d.receivables.overduePen).toBe('85.7500');
    expect(
      new Decimal(d.receivables.overduePen)
        .plus(BUCKETS.CURRENT)
        .equals(RECEIVABLES.totals.balancePen),
    ).toBe(true);
    expect(d.receivables.documentCount).toBe(4);
    expect(d.receivables.customerCount).toBe(2);
  });

  it('inventario valorizado: los totales del reporte', () => {
    expect(assemble().inventory).toEqual({
      totalValuePen: '1250.0000',
      coilValuePen: '1000.0000',
      productValuePen: '250.0000',
    });
  });

  it('«Fuera de tolerancia»: las producciones y las bobinas que el reporte de merma marca, por pestaña', () => {
    expect(assemble().outOfTolerance).toEqual([
      { businessLine: BusinessLine.METALLIC_ROOFING, productionCount: 3, coilCount: 2 },
      { businessLine: BusinessLine.DRYWALL, productionCount: 2, coilCount: 2 },
    ]);
  });
});

describe('AdminDashboardService (presupuesto de consultas)', () => {
  function build() {
    const salesMargin = {
      salesMargin: jest
        .fn()
        .mockImplementation((q: { from: string }) =>
          Promise.resolve(q.from === '2026-10-01' ? SALES_CURRENT : SALES_PREVIOUS),
        ),
    };
    const receivablesAging = { report: jest.fn().mockResolvedValue(RECEIVABLES) };
    const inventoryValuation = { valuation: jest.fn().mockResolvedValue(INVENTORY) };
    const coilWaste = {
      report: jest
        .fn()
        .mockImplementation((q: { businessLine: string }) =>
          Promise.resolve(WASTE.find((w) => w.businessLine === q.businessLine)),
        ),
    };
    const service = new AdminDashboardService(
      salesMargin as unknown as SalesMarginService,
      receivablesAging as unknown as ReceivablesAgingService,
      inventoryValuation as unknown as InventoryValuationService,
      coilWaste as unknown as CoilWasteService,
    );
    return { service, salesMargin, receivablesAging, inventoryValuation, coilWaste };
  }

  it('lee cada reporte una sola vez por rango, con el rango que su enlace lleva', async () => {
    const { service, salesMargin, receivablesAging, inventoryValuation, coilWaste } = build();
    const d = await service.dashboard('2026-10-06');

    expect(salesMargin.salesMargin).toHaveBeenCalledTimes(2);
    expect(salesMargin.salesMargin).toHaveBeenCalledWith({ from: '2026-10-01', to: '2026-10-06' });
    expect(salesMargin.salesMargin).toHaveBeenCalledWith({ from: '2026-09-01', to: '2026-09-06' });
    expect(receivablesAging.report).toHaveBeenCalledTimes(1);
    expect(receivablesAging.report).toHaveBeenCalledWith({});
    expect(inventoryValuation.valuation).toHaveBeenCalledTimes(1);
    expect(inventoryValuation.valuation).toHaveBeenCalledWith({});
    expect(coilWaste.report).toHaveBeenCalledTimes(2);
    expect(coilWaste.report).toHaveBeenCalledWith({
      from: '2026-10-01',
      to: '2026-10-06',
      businessLine: BusinessLine.METALLIC_ROOFING,
    });
    expect(coilWaste.report).toHaveBeenCalledWith({
      from: '2026-10-01',
      to: '2026-10-06',
      businessLine: BusinessLine.DRYWALL,
    });

    expect(d.current).toEqual({ from: '2026-10-01', to: '2026-10-06' });
    expect(d.previous).toEqual({ from: '2026-09-01', to: '2026-09-06' });
    expect(d.sales.salesPen).toBe('900.0000');
    expect(d.previousSalesPen).toBe('700.0000');
  });
});
