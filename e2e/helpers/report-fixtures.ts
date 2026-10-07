import { expect, type Page } from '@playwright/test';
import {
  businessToday,
  type CoilMonthReportDto,
  type CoilMonthReportRowDto,
  type CoilWasteDto,
  type CoilWasteRowDto,
  type InventoryValuationDto,
  type ProductionSummaryDto,
  type ProductionSummaryOrderDto,
  type ReceivablesAgingCustomerDto,
  type ReceivablesAgingDto,
  type SalesByMaterialDto,
  type SalesMaterialFiguresDto,
  type SalesMaterialRowDto,
} from '@ayr/shared';
import { adminCredentials } from './api';

/**
 * cc32 (corte 2) — los fixtures de los seis reportes de la plantilla, para probar la pantalla
 * sin depender de los datos de la base (`page.route`). Solo lectura.
 */

export async function loginAsAdmin(page: Page): Promise<void> {
  const { email, password } = adminCredentials();
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await expect(page).toHaveURL(/\/$/, { timeout: 60_000 });
}

export function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

export function firstOfMonth(today: string): string {
  return `${today.slice(0, 7)}-01`;
}

export function previousMonth(today: string): { from: string; to: string; month: string } {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const [y, m] = month === 1 ? [year - 1, 12] : [year, month - 1];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const mm = String(m).padStart(2, '0');
  return {
    from: `${String(y)}-${mm}-01`,
    to: `${String(y)}-${mm}-${String(last)}`,
    month: `${String(y)}-${mm}`,
  };
}

/* ------------------------------------------------------------------------------------- *
 * Fixtures
 * ------------------------------------------------------------------------------------- */

function wasteRow(
  n: number,
  consumed: string,
  theoretical: string | null,
  waste: string | null,
  pct: string | null,
): CoilWasteRowDto {
  return {
    coilId: uuid(n),
    code: `BOB-E2E-00${String(n)}`,
    kind: 'COIL',
    typeKey: 'AZ150-0.40',
    colorName: 'ROJO',
    widthMm: '1200.00',
    status: 'OPEN',
    consumedKg: consumed,
    theoreticalKg: theoretical,
    differenceKg: waste,
    trimKg: '0.000',
    closeAdjustmentKg: '0.000',
    wasteKg: waste,
    wastePct: pct,
    overStandard: pct !== null && Number(pct) > 1,
    manualScrapKg: '0.000',
    productions: [
      {
        reportId: uuid(500 + n),
        productionOrderId: uuid(600 + n),
        productionOrderCode: `OP-E2E-00${String(n)}`,
        operationDate: '2026-10-02',
        consumedKg: consumed,
        theoreticalKg: theoretical,
        missingTheoretical: theoretical === null ? 'NO_REPORT' : null,
        outOfTolerance: null,
      },
    ],
  };
}

/** Tres bobinas: consumido 1,250.50 + 2,000.25 + 500.00 = 3,750.75 kg. */
function wasteFixture(from: string, to: string): CoilWasteDto {
  return {
    from,
    to,
    businessLine: 'metallic-roofing',
    standardPct: '1.00',
    rows: [
      wasteRow(1, '1250.500', '1240.000', '10.500', '0.85'),
      wasteRow(2, '2000.250', '1960.000', '40.250', '2.05'),
      wasteRow(3, '500.000', null, null, null),
    ],
    totals: {
      coilCount: 3,
      consumedKg: '3750.750',
      trimKg: '0.000',
      closeAdjustmentKg: '0.000',
      manualScrapKg: '0.000',
      comparableCoilCount: 2,
      comparableConsumedKg: '3250.750',
      theoreticalKg: '3200.000',
      differenceKg: '50.750',
      wasteKg: '50.750',
      wastePct: '1.59',
      overStandard: true,
    },
  };
}

function opRow(
  n: number,
  theoretical: string,
  consumed: string,
  pct: string,
): ProductionSummaryOrderDto {
  return {
    productionOrderId: uuid(700 + n),
    code: `OP-E2E-10${String(n)}`,
    status: 'COMPLETED',
    salesOrderId: uuid(800),
    salesOrderCode: 'PED-E2E-080',
    lineNumber: n,
    productId: uuid(900 + n),
    productSku: `COB-E2E-${String(n)}`,
    productName: `Cobertura E2E ${String(n)}`,
    quantity: '120.000',
    quantityUnit: 'm',
    reportCount: 1,
    theoreticalKg: theoretical,
    consumedKg: consumed,
    trimKg: '0.000',
    wastePct: pct,
    overStandard: Number(pct) > 1,
    materialCostPen: '1000.0000',
    trimCostPen: '0.0000',
    coils: [
      { coilId: uuid(n), code: `BOB-E2E-00${String(n)}`, consumedKg: consumed, trimKg: '0.000' },
    ],
  };
}

/** Dos órdenes de un pedido: salido 500.00 + 1,010.00 = 1,510.00 kg. */
function productionFixture(from: string, to: string): ProductionSummaryDto {
  const orders = [opRow(1, '500.000', '500.000', '0.00'), opRow(2, '1000.000', '1010.000', '1.00')];
  const figures = {
    theoreticalKg: '1500.000',
    consumedKg: '1510.000',
    trimKg: '0.000',
    wastePct: '0.67',
    overStandard: false,
    materialCostPen: '2000.0000',
    trimCostPen: '0.0000',
  };
  return {
    from,
    to,
    businessLine: 'metallic-roofing',
    standardPct: '1.00',
    withCosts: true,
    groups: [{ salesOrderId: uuid(800), salesOrderCode: 'PED-E2E-080', orders, subtotal: figures }],
    totals: { orderCount: 2, ...figures, unattributedKg: '0.000' },
  };
}

function figures(sales: string, cost: string, real: string): SalesMaterialFiguresDto {
  return {
    metersSold: '100.000',
    theoreticalKg: real,
    realKg: real,
    yieldKg: '0.000',
    yieldPct: '0.00',
    salesPen: sales,
    costPen: cost,
    profitPen: (Number(sales) - Number(cost)).toFixed(4),
    costPerKgPen: null,
    pricePerKgPen: null,
    marginPerKgPen: null,
    pricePerMeterPen: null,
    costPerMeterPen: null,
    marginPerMeterPen: null,
    unit: 'MTR',
    qty: '100.000',
    costPerUnitPen: null,
  };
}

function materialRow(n: number, color: string, sales: string, cost: string): SalesMaterialRowDto {
  return {
    ...figures(sales, cost, '400.000'),
    kind: 'COBERTURA',
    thicknessMm: '0.40',
    colorLabel: color,
    lineCount: 1,
    coils: [
      {
        coilId: uuid(n),
        code: `BOB-E2E-00${String(n)}`,
        typeKey: 'AZ150-0.40',
        thicknessMm: '0.40',
        colorLabel: color,
        kg: '400.000',
        theoreticalKg: '400.000',
        meters: '100.000',
        costPen: cost,
        avgCostPen: '5.0000',
        documents: [
          {
            documentId: uuid(100 + n),
            documentNumber: `F001-0000010${String(n)}`,
            issueDate: '2026-10-03',
            customerName: 'Constructora Los Álamos',
            kg: '400.000',
            meters: '100.000',
          },
        ],
      },
    ],
  };
}

/** Dos filas: venta 3,000.00 + 1,500.50 = 4,500.50. */
function materialFixture(from: string, to: string): SalesByMaterialDto {
  const rows = [
    materialRow(1, 'ROJO', '3000.0000', '2000.0000'),
    materialRow(2, 'AZUL', '1500.5000', '1000.0000'),
  ];
  return {
    from,
    to,
    businessLine: 'metallic-roofing',
    rows,
    subtotals: [{ ...figures('4500.5000', '3000.0000', '800.000'), kind: 'COBERTURA' }],
    total: figures('4500.5000', '3000.0000', '800.000'),
    untraceable: [],
    untraceableSalesPen: '0.0000',
    reconciliation: {
      lineSalesPen: '4500.5000',
      coilSalesPen: '0.0000',
      unclassifiedSalesPen: '0.0000',
    },
    noLineSalesPen: '0.0000',
    products: null,
  };
}

function customer(n: number, name: string, balance: string): ReceivablesAgingCustomerDto {
  return {
    customerId: uuid(n),
    customerName: name,
    customerDocNumber: `2010000000${String(n)}`,
    documentCount: 1,
    balancePen: balance,
    buckets: {
      CURRENT: '0.0000',
      D1_30: balance,
      D31_60: '0.0000',
      D61_90: '0.0000',
      OVER_90: '0.0000',
    },
    documents: [
      {
        id: uuid(200 + n),
        docType: 'FACTURA',
        number: `F001-0000020${String(n)}`,
        issueDate: '2026-09-01',
        paymentTerms: 'CREDITO',
        dueDate: '2026-10-01',
        agingDate: '2026-10-01',
        daysOverdue: 6,
        bucket: 'D1_30',
        totalPen: balance,
        paidPen: '0.0000',
        creditedPen: '0.0000',
        balancePen: balance,
        salesOrderId: uuid(300 + n),
        salesOrderCode: `PED-E2E-30${String(n)}`,
        sellerId: uuid(400),
        sellerName: 'Gabriela R.',
      },
    ],
  };
}

function receivablesFixture(): ReceivablesAgingDto {
  return {
    asOf: businessToday(),
    sellerId: null,
    sellers: [{ id: uuid(400), name: 'Gabriela R.' }],
    customers: [
      customer(1, 'Techos del Sur', '5000.0000'),
      customer(2, 'Drywall Norte', '1200.5000'),
    ],
    totals: {
      balancePen: '6200.5000',
      buckets: {
        CURRENT: '0.0000',
        D1_30: '6200.5000',
        D31_60: '0.0000',
        D61_90: '0.0000',
        OVER_90: '0.0000',
      },
      documentCount: 2,
      customerCount: 2,
    },
  };
}

function inventoryFixture(): InventoryValuationDto {
  return {
    asOf: businessToday(),
    coilGroups: [
      {
        key: 'g1',
        businessLine: 'metallic-roofing',
        thicknessMm: '0.40',
        colorName: 'ROJO',
        finishKind: null,
        finishes: [
          {
            finishCode: 'AZR3002',
            finishName: 'Rojo teja',
            ral: '3002',
            coilCount: 1,
            qtyKg: '1000.000',
            totalValuePen: '5000.0000',
          },
        ],
        coilCount: 1,
        qtyKg: '1000.000',
        avgCostPen: '5.0000',
        totalValuePen: '5000.0000',
        coils: [
          {
            id: uuid(1),
            code: 'BOB-E2E-001',
            typeKey: 'AZR3002-0.40',
            kind: 'COIL',
            widthMm: '1200.00',
            finishCode: 'AZR3002',
            ral: '3002',
            qtyKg: '1000.000',
            avgCostPen: '5.0000',
            totalValuePen: '5000.0000',
            status: 'OPEN',
            operationDate: '2026-09-15',
          },
        ],
      },
    ],
    products: [
      {
        itemId: uuid(50),
        businessLine: 'metallic-roofing',
        sku: 'CUM-E2E',
        name: 'Cumbrera E2E',
        qty: '10.000',
        unit: 'NIU',
        avgCostPen: '25.0000',
        totalValuePen: '250.0000',
      },
    ],
    totalsByLine: [
      {
        businessLine: 'metallic-roofing',
        coilValuePen: '5000.0000',
        productValuePen: '250.0000',
        totalValuePen: '5250.0000',
      },
    ],
    totals: {
      coilValuePen: '5000.0000',
      coilQtyKg: '1000.000',
      productValuePen: '250.0000',
      totalValuePen: '5250.0000',
    },
  };
}

function coilRow(n: number, closing: string): CoilMonthReportRowDto {
  return {
    id: uuid(n),
    code: `BOB-E2E-00${String(n)}`,
    typeKey: 'AZ150-0.40',
    kind: 'COIL',
    businessLine: 'metallic-roofing',
    colorName: 'ROJO',
    widthMm: '1200.00',
    openingKg: '2000.000',
    weightKg: '2000.000',
    closingKg: closing,
    unitCostPerKg: '5.0000',
    closingValuePen: (Number(closing) * 5).toFixed(4),
    status: 'OPEN',
    operationDate: '2026-08-01',
  };
}

function coilsFixture(month: string): CoilMonthReportDto {
  const sealed = [coilRow(1, '2000.000'), coilRow(2, '1500.000')];
  const totals = {
    openingKg: '4000.000',
    weightKg: '4000.000',
    closingKg: '3500.000',
    closingValuePen: '17500.0000',
  };
  return {
    month,
    businessLine: 'metallic-roofing',
    from: `${month}-01`,
    to: `${month}-28`,
    sealed: { rows: sealed, totals },
    opened: {
      rows: [],
      totals: {
        openingKg: '0.000',
        weightKg: '0.000',
        closingKg: '0.000',
        closingValuePen: '0.0000',
      },
    },
    totals,
    finished: { count: 0, consumedKg: '0.000' },
    annulledWithOpening: { count: 0, openingKg: '0.000' },
    flow: { openingKg: '4000.000', entriesKg: '0.000', exitsKg: '500.000', closingKg: '3500.000' },
  };
}

/** Todas las rutas de los seis reportes (y Ventas y margen vacío), con su fixture. */
export async function mockReports(page: Page): Promise<void> {
  await page.route(
    (url) => url.pathname.startsWith('/api/reports/') && !url.pathname.endsWith('/xlsx'),
    async (route) => {
      const url = new URL(route.request().url());
      const from = url.searchParams.get('from') ?? '';
      const to = url.searchParams.get('to') ?? '';
      switch (url.pathname) {
        case '/api/reports/coil-waste':
          return route.fulfill({ json: wasteFixture(from, to) });
        case '/api/reports/production-summary':
          return route.fulfill({ json: productionFixture(from, to) });
        case '/api/reports/sales-by-material':
          return route.fulfill({ json: materialFixture(from, to) });
        case '/api/reports/receivables-aging':
          return route.fulfill({ json: receivablesFixture() });
        case '/api/reports/inventory-valuation':
          return route.fulfill({ json: inventoryFixture() });
        case '/api/reports/coils':
          return route.fulfill({ json: coilsFixture(url.searchParams.get('month') ?? '') });
        default:
          return route.fallback();
      }
    },
  );
}
