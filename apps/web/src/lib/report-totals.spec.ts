import { describe, expect, it } from 'vitest';
import type {
  CoilMonthReportRowDto,
  CoilWasteRowDto,
  ReceivablesAgingCustomerDto,
  SalesMaterialFiguresDto,
} from '@ayr/shared';
import {
  agingTotalsOf,
  allRows,
  coilMonthTotalsOf,
  materialFiguresOf,
  productionTotalsOf,
  wasteTotalsOf,
} from './report-totals';
import { formatAmount, formatKg } from './format';

/** cc32 (corte 2) — el total al pie de los reportes, sobre las filas a la vista. */

function figures(over: Partial<SalesMaterialFiguresDto>): SalesMaterialFiguresDto {
  return {
    metersSold: '0.000',
    theoreticalKg: '0.000',
    realKg: '0.000',
    yieldKg: '0.000',
    yieldPct: null,
    salesPen: '0.0000',
    costPen: '0.0000',
    profitPen: '0.0000',
    costPerKgPen: null,
    pricePerKgPen: null,
    marginPerKgPen: null,
    pricePerMeterPen: null,
    costPerMeterPen: null,
    marginPerMeterPen: null,
    unit: 'MTR',
    qty: '0.000',
    costPerUnitPen: null,
    ...over,
  };
}

describe('Ventas por material', () => {
  it('suma y saca los cocientes de las sumas, como el API', () => {
    const total = materialFiguresOf([
      figures({
        metersSold: '10.000',
        theoreticalKg: '40.000',
        realKg: '40.400',
        salesPen: '300.0000',
        costPen: '200.0000',
        qty: '10.000',
      }),
      figures({
        metersSold: '30.000',
        theoreticalKg: '120.000',
        realKg: '121.200',
        salesPen: '900.0000',
        costPen: '606.0000',
        qty: '30.000',
      }),
    ]);
    expect(formatAmount(total.salesPen)).toBe('1,200.00');
    expect(formatAmount(total.profitPen)).toBe('394.00');
    expect(formatKg(total.realKg, null)).toBe('161.60');
    expect(formatKg(total.yieldKg, null)).toBe('-1.60');
    expect(total.yieldPct).toBe('-1.00');
    // Costo/kg = 806 ÷ 161.6, no el promedio de los dos costos/kg.
    expect(formatAmount(total.costPerKgPen ?? '', 4)).toBe('4.9876');
    expect(formatAmount(total.pricePerMeterPen ?? '', 4)).toBe('30.0000');
    expect(total.unit).toBe('MTR');
    expect(formatAmount(total.costPerUnitPen ?? '', 4)).toBe('20.1500');
  });

  it('sin peso real ni metros, los cocientes van vacíos; unidades mezcladas, sin costo por unidad', () => {
    const total = materialFiguresOf([
      figures({ salesPen: '10.0000', unit: 'MTR', qty: '1.000' }),
      figures({ salesPen: '5.0000', unit: 'NIU', qty: '2.000' }),
    ]);
    expect(total.costPerKgPen).toBeNull();
    expect(total.pricePerMeterPen).toBeNull();
    expect(total.unit).toBeNull();
    expect(total.costPerUnitPen).toBeNull();
    expect(total.yieldPct).toBeNull();
  });
});

function wasteRow(over: Partial<CoilWasteRowDto>): CoilWasteRowDto {
  return {
    coilId: '00000000-0000-4000-8000-000000000001',
    code: 'B-1',
    kind: 'COIL',
    typeKey: 'AZ-0.30',
    finishName: 'Aluzinc',
    colorName: null,
    widthMm: '1200.00',
    status: 'OPEN',
    consumedKg: '0.000',
    theoreticalKg: '0.000',
    differenceKg: '0.000',
    trimKg: '0.000',
    closeAdjustmentKg: '0.000',
    wasteKg: '0.000',
    wastePct: null,
    overStandard: false,
    manualScrapKg: '0.000',
    productions: [],
    ...over,
  };
}

describe('Merma por bobina', () => {
  it('el teórico y la merma son solo de las bobinas con teórico completo', () => {
    const totals = wasteTotalsOf(
      [
        wasteRow({
          consumedKg: '102.000',
          theoreticalKg: '100.000',
          differenceKg: '2.000',
          trimKg: '1.000',
          wasteKg: '3.000',
        }),
        wasteRow({
          consumedKg: '50.000',
          theoreticalKg: null,
          differenceKg: null,
          wasteKg: null,
          manualScrapKg: '4.000',
        }),
      ],
      '1.00',
    );
    expect(totals.coilCount).toBe(2);
    expect(totals.comparableCoilCount).toBe(1);
    expect(formatKg(totals.consumedKg, null)).toBe('152.00');
    expect(formatKg(totals.comparableConsumedKg, null)).toBe('102.00');
    expect(formatKg(totals.theoreticalKg, null)).toBe('100.00');
    expect(formatKg(totals.manualScrapKg, null)).toBe('4.00');
    expect(totals.wastePct).toBe('3.00');
    expect(totals.overStandard).toBe(true);
  });

  it('hasta el estándar no se marca; sin teórico, sin porcentaje', () => {
    expect(
      wasteTotalsOf([wasteRow({ theoreticalKg: '100.000', wasteKg: '1.000' })], '1.00')
        .overStandard,
    ).toBe(false);
    expect(
      wasteTotalsOf([wasteRow({ theoreticalKg: null, wasteKg: null })], '1.00').wastePct,
    ).toBeNull();
  });
});

describe('Reporte de producción', () => {
  it('% sobre el estándar = (salido − teórico + despunte) ÷ teórico', () => {
    const totals = productionTotalsOf(
      [
        {
          theoreticalKg: '100.000',
          consumedKg: '100.500',
          trimKg: '0.500',
          materialCostPen: '400.0000',
          trimCostPen: '2.0000',
        },
        {
          theoreticalKg: '100.000',
          consumedKg: '101.000',
          trimKg: '0.000',
          materialCostPen: '404.0000',
          trimCostPen: '0.0000',
        },
      ],
      '1.00',
    );
    expect(totals.wastePct).toBe('1.00');
    expect(totals.overStandard).toBe(false);
    expect(formatAmount(totals.materialCostPen ?? '')).toBe('804.00');
  });

  it('sin costos (supervisor), el costo del total va vacío', () => {
    const totals = productionTotalsOf(
      [
        {
          theoreticalKg: '0.000',
          consumedKg: '1.000',
          trimKg: '0.000',
          materialCostPen: null,
          trimCostPen: null,
        },
      ],
      '1.00',
    );
    expect(totals.materialCostPen).toBeNull();
    expect(totals.wastePct).toBeNull();
  });
});

describe('Cuentas por cobrar y bobinas', () => {
  it('suma los tramos y el saldo de los clientes', () => {
    const customer = (balance: string, overdue: string, docs: number) =>
      ({
        customerId: '00000000-0000-4000-8000-000000000001',
        customerName: 'X',
        customerDocNumber: '20100000001',
        documentCount: docs,
        balancePen: balance,
        buckets: {
          CURRENT: '0.0000',
          D1_30: overdue,
          D31_60: '0.0000',
          D61_90: '0.0000',
          OVER_90: '0.0000',
        },
        documents: [],
      }) as unknown as ReceivablesAgingCustomerDto;
    const totals = agingTotalsOf([
      customer('100.0050', '100.0050', 1),
      customer('0.0050', '0.0050', 2),
    ]);
    expect(totals.documentCount).toBe(3);
    expect(formatAmount(totals.balancePen)).toBe('100.01');
    expect(formatAmount(totals.buckets.CURRENT)).toBe('0.00');
  });

  it('el subtotal de bobinas lleva valor solo si el rol lo ve', () => {
    const row = (closingValuePen: string | null) =>
      ({
        openingKg: '10.000',
        weightKg: '20.000',
        closingKg: '5.000',
        closingValuePen,
      }) as CoilMonthReportRowDto;
    expect(coilMonthTotalsOf([row('1.0000'), row('2.0000')]).closingValuePen?.toFixed(2)).toBe(
      '3.00',
    );
    expect(coilMonthTotalsOf([row(null)]).closingValuePen).toBeNull();
    expect(allRows([1], [1])).toBe(true);
    expect(allRows([1], [1, 2])).toBe(false);
  });
});
