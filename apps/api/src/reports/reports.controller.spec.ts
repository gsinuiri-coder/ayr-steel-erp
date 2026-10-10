import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import * as XLSX from 'xlsx';
import { Role, type CoilMonthReportDto, type SalesByMaterialDto } from '@ayr/shared';
import type { RequestUser } from '../auth/auth.types';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import type { InventoryValuationService } from './inventory-valuation.service';
import type { KardexPepsService } from './kardex-peps.service';
import type { DocumentProfitabilityService } from './document-profitability.service';
import type { KardexSheetService } from './kardex-sheet.service';
import { ReportsController } from './reports.controller';
import type { AdminDashboardService } from './admin-dashboard.service';
import type { PlantDashboardService } from './plant-dashboard.service';
import type { SellerDashboardService } from './seller-dashboard.service';
import type { CoilWasteService } from './coil-waste.service';
import type { ProductionSummaryService } from './production-summary.service';
import type { ReceivablesAgingService } from './receivables-aging.service';
import type { ReportsService } from './reports.service';
import type { SalesByMaterialService } from './sales-by-material.service';
import type { SalesMarginService } from './sales-margin.service';

/**
 * RF-S4b/M3 (deuda de RF-S4a): el controlador de reportes. Lo que se fija acá es lo que los
 * servicios no ven: **quién** entra a cada ruta, que el xlsx sale del **mismo** DTO que la
 * pantalla (una sola consulta), y que `/reports/coils` enmascara costos por rol.
 */

function actor(role: Role): RequestUser {
  return {
    id: 'u-1',
    email: 'x@ayr.local',
    name: 'X',
    role,
    mustChangePassword: false,
    sessionId: 's-1',
  };
}

function fakeResponse(): Response & { headers: Record<string, string>; body: unknown } {
  const res = {
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    setHeader(name: string, value: string) {
      res.headers[name] = value;
      return res;
    },
    send(body: unknown) {
      res.body = body;
      return res;
    },
  };
  return res as unknown as Response & { headers: Record<string, string>; body: unknown };
}

const VALUATION = {
  asOf: '2026-09-23',
  coilGroups: [],
  products: [],
  totalsByLine: [],
  totals: {
    coilValuePen: '0.00',
    coilQtyKg: '0.000',
    productValuePen: '0.00',
    totalValuePen: '0.00',
  },
};
const MARGIN = {
  from: '2026-08-01',
  to: '2026-08-31',
  orders: [],
  totalsByLine: [],
  totals: {
    roundingPen: '0.0000',
    salesPen: '0.00',
    costPen: '0.00',
    marginPen: '0.00',
    marginPct: null,
    partialOrderCount: 0,
    excludedOrderCount: 0,
    excludedSalesPen: '0.00',
  },
};

const EMPTY_BALANCE = { qty: '0.000', unitCost: '0.0000', total: '0.0000', layers: [] };
const PEPS = {
  from: '2026-09-01',
  to: '2026-09-30',
  companyRuc: '',
  companyName: '',
  itemCode: 'BOB-001',
  itemDescription: 'Bobina GALV-0.50',
  existenceType: '03 - MATERIAS PRIMAS',
  unitCode: '01 - KILOGRAMOS',
  peps: {
    opening: EMPTY_BALANCE,
    rows: [],
    closing: EMPTY_BALANCE,
    totals: { inQty: '0.000', inTotal: '0.0000', outQty: '0.000', outTotal: '0.0000' },
    warnings: [],
  },
  documents: new Map(),
};

const FIGURES = {
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
  unit: null,
  qty: null,
  costPerUnitPen: null,
};

const BY_MATERIAL: SalesByMaterialDto = {
  from: '2026-09-01',
  to: '2026-09-30',
  businessLine: 'metallic-roofing',
  rows: [],
  subtotals: [],
  total: FIGURES,
  untraceable: [],
  untraceableSalesPen: '0.0000',
  reconciliation: {
    lineSalesPen: '0.0000',
    coilSalesPen: '0.0000',
    unclassifiedSalesPen: '0.0000',
  },
  noLineSalesPen: '0.0000',
  products: null,
};

const EMPTY_SECTION = {
  rows: [],
  totals: { openingKg: '0.000', weightKg: '0.000', closingKg: '0.000', closingValuePen: null },
};

const COIL_MONTH: CoilMonthReportDto = {
  month: '2026-08',
  businessLine: null,
  from: '2026-08-01',
  to: '2026-08-31',
  sealed: EMPTY_SECTION,
  opened: EMPTY_SECTION,
  totals: EMPTY_SECTION.totals,
  finished: { count: 0, consumedKg: '0.000' },
  annulledWithOpening: { count: 0, openingKg: '0.000' },
  flow: { openingKg: '0.000', entriesKg: '0.000', exitsKg: '0.000', closingKg: '0.000' },
};

function build() {
  const reports = { coilsByMonth: jest.fn().mockResolvedValue({ rows: [] }) };
  const inventoryValuation = { valuation: jest.fn().mockResolvedValue(VALUATION) };
  const salesMargin = { salesMargin: jest.fn().mockResolvedValue(MARGIN) };
  const salesByMaterial = { report: jest.fn().mockResolvedValue(BY_MATERIAL) };
  const kardexPeps = { report: jest.fn().mockResolvedValue(PEPS) };
  const kardexSheet = { sheet: jest.fn() };
  const documentProfitability = { profitability: jest.fn().mockResolvedValue({ applies: true }) };
  const receivablesAging = { report: jest.fn().mockResolvedValue({ customers: [] }) };
  const coilWaste = { report: jest.fn().mockResolvedValue({ rows: [] }) };
  const productionSummary = { report: jest.fn().mockResolvedValue({ groups: [] }) };
  const adminDashboard = { dashboard: jest.fn().mockResolvedValue({}) };
  const plantDashboard = { dashboard: jest.fn().mockResolvedValue({}) };
  const sellerDashboard = { dashboard: jest.fn().mockResolvedValue({}) };
  const controller = new ReportsController(
    reports as unknown as ReportsService,
    inventoryValuation as unknown as InventoryValuationService,
    salesMargin as unknown as SalesMarginService,
    salesByMaterial as unknown as SalesByMaterialService,
    kardexPeps as unknown as KardexPepsService,
    kardexSheet as unknown as KardexSheetService,
    documentProfitability as unknown as DocumentProfitabilityService,
    receivablesAging as unknown as ReceivablesAgingService,
    coilWaste as unknown as CoilWasteService,
    productionSummary as unknown as ProductionSummaryService,
    adminDashboard as unknown as AdminDashboardService,
    plantDashboard as unknown as PlantDashboardService,
    sellerDashboard as unknown as SellerDashboardService,
  );
  return {
    controller,
    reports,
    inventoryValuation,
    salesMargin,
    salesByMaterial,
    kardexPeps,
    kardexSheet,
    documentProfitability,
    receivablesAging,
    coilWaste,
    productionSummary,
  };
}

describe('ReportsController', () => {
  const reflector = new Reflector();
  const rolesOf = (method: keyof ReportsController): Role[] | undefined =>
    reflector.get<Role[]>(ROLES_KEY, ReportsController.prototype[method]);

  it('los reportes de costeo son solo de ADMINISTRADOR; el de bobinas, también de planta', () => {
    expect(rolesOf('inventoryValuationReport')).toEqual([Role.ADMINISTRADOR]);
    expect(rolesOf('salesMarginReport')).toEqual([Role.ADMINISTRADOR]);
    expect(rolesOf('inventoryValuationXlsxFile')).toEqual([Role.ADMINISTRADOR]);
    expect(rolesOf('salesMarginXlsxFile')).toEqual([Role.ADMINISTRADOR]);
    // D-354: ventas por material lleva costos.
    expect(rolesOf('salesByMaterialReport')).toEqual([Role.ADMINISTRADOR]);
    expect(rolesOf('salesByMaterialXlsxFile')).toEqual([Role.ADMINISTRADOR]);
    expect(rolesOf('kardexPepsXlsxFile')).toEqual([Role.ADMINISTRADOR]);
    // D-296/D-298: el PEPS en JSON y el Excel del cliente llevan costos: solo ADMINISTRADOR.
    expect(rolesOf('kardexPepsJson')).toEqual([Role.ADMINISTRADOR]);
    expect(rolesOf('kardexSheetXlsxFile')).toEqual([Role.ADMINISTRADOR]);
    // C06: la rentabilidad de un comprobante lleva costos: un VENDEDOR recibe 403.
    expect(rolesOf('documentProfitabilityReport')).toEqual([Role.ADMINISTRADOR]);
    // cc25 (D-426): cuentas por cobrar, solo ADMINISTRADOR.
    expect(rolesOf('receivablesAgingReport')).toEqual([Role.ADMINISTRADOR]);
    expect(rolesOf('receivablesAgingXlsxFile')).toEqual([Role.ADMINISTRADOR]);
    // cc25 (D-426): merma, solo ADMINISTRADOR; cc39 (D-580): también su Excel.
    expect(rolesOf('coilWasteReport')).toEqual([Role.ADMINISTRADOR]);
    expect(rolesOf('coilWasteXlsxFile')).toEqual([Role.ADMINISTRADOR]);
    // cc29 (M2): producción, administrador y planta; los costos los decide el rol (abajo).
    expect(rolesOf('productionSummaryReport')).toEqual([
      Role.ADMINISTRADOR,
      Role.SUPERVISOR_PLANTA,
    ]);
    expect(rolesOf('productionSummaryXlsxFile')).toEqual([
      Role.ADMINISTRADOR,
      Role.SUPERVISOR_PLANTA,
    ]);
    // cc26 (D-440): el Panel del administrador lleva costos y márgenes.
    expect(rolesOf('adminDashboardReport')).toEqual([Role.ADMINISTRADOR]);
    // cc26 (D-440): el de planta, con los roles de las lecturas de planta.
    expect(rolesOf('plantDashboardReport')).toEqual([Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA]);
    // cc27 (M4, D-457): el Panel del vendedor es solo del vendedor, con su alcance.
    expect(rolesOf('sellerDashboardReport')).toEqual([Role.VENDEDOR]);
    expect(rolesOf('coils')).toEqual([Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA]);
    expect(rolesOf('coilsXlsxFile')).toEqual([Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA]);
    expect(rolesOf('coilsPdfFile')).toEqual([Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA]);
  });

  it('cc29: el reporte de producción lleva costos solo para el administrador', async () => {
    const { controller, productionSummary } = build();
    const query = { from: '2026-10-01', to: '2026-10-06' } as never;
    await controller.productionSummaryReport(query, actor(Role.ADMINISTRADOR));
    await controller.productionSummaryReport(query, actor(Role.SUPERVISOR_PLANTA));
    expect(productionSummary.report.mock.calls.map((c: unknown[]) => c[1])).toEqual([true, false]);
  });

  it('/reports/coils muestra costos a ADMINISTRADOR y a planta, y a nadie más', async () => {
    const { controller, reports } = build();
    const query = { month: '2026-08' } as never;
    await controller.coils(actor(Role.ADMINISTRADOR), query);
    await controller.coils(actor(Role.SUPERVISOR_PLANTA), query);
    await controller.coils(actor(Role.VENDEDOR), query);
    expect(reports.coilsByMonth.mock.calls.map((c: unknown[]) => c[1])).toEqual([
      true,
      true,
      false,
    ]);
  });

  it('el xlsx del reporte mensual usa el mismo mes y el mismo enmascarado (D-355)', async () => {
    const { controller, reports } = build();
    reports.coilsByMonth.mockResolvedValue(COIL_MONTH);
    const res = fakeResponse();
    await controller.coilsXlsxFile(actor(Role.SUPERVISOR_PLANTA), { month: '2026-08' }, {}, res);
    expect(reports.coilsByMonth).toHaveBeenCalledWith({ month: '2026-08' }, true);
    expect(res.headers['Content-Disposition']).toBe(
      'attachment; filename="reporte-bobinas-2026-08.xlsx"',
    );
  });

  it('el PDF del reporte mensual usa el mismo mes y enmascara para quien no ve costos (D-355)', async () => {
    const { controller, reports } = build();
    reports.coilsByMonth.mockResolvedValue(COIL_MONTH);
    const res = fakeResponse();
    await controller.coilsPdfFile(actor(Role.VENDEDOR), { month: '2026-08' }, res);
    expect(reports.coilsByMonth).toHaveBeenCalledWith({ month: '2026-08' }, false);
    expect(res.headers['Content-Type']).toBe('application/pdf');
    expect(res.headers['Content-Disposition']).toBe(
      'attachment; filename="reporte-bobinas-2026-08.pdf"',
    );
  });

  it('las rutas JSON devuelven el DTO del servicio tal cual', async () => {
    const { controller, salesMargin } = build();
    await expect(controller.inventoryValuationReport({})).resolves.toBe(VALUATION);
    const query = { from: '2026-08-01', to: '2026-08-31' };
    await expect(controller.salesMarginReport(query)).resolves.toBe(MARGIN);
    expect(salesMargin.salesMargin).toHaveBeenCalledWith(query);
  });

  it('el xlsx de inventario sale de una sola consulta y viaja como adjunto', async () => {
    const { controller, inventoryValuation } = build();
    const res = fakeResponse();
    await controller.inventoryValuationXlsxFile({}, {}, res);
    expect(inventoryValuation.valuation).toHaveBeenCalledTimes(1);
    expect(res.headers['Content-Type']).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(res.headers['Content-Disposition']).toMatch(/^attachment; filename=".+\.xlsx"$/);
    expect(Buffer.isBuffer(res.body)).toBe(true);
  });

  it('cc39 (D-580): cada Excel pide al servicio la misma consulta que su pantalla, con la línea', async () => {
    const { controller, inventoryValuation, salesMargin, salesByMaterial, coilWaste } = build();
    coilWaste.report.mockResolvedValue({
      from: '2026-09-01',
      to: '2026-09-30',
      businessLine: 'drywall',
      standardPct: '1.00',
      rows: [],
      totals: {
        coilCount: 0,
        consumedKg: '0.000',
        trimKg: '0.000',
        closeAdjustmentKg: '0.000',
        manualScrapKg: '0.000',
        comparableCoilCount: 0,
        comparableConsumedKg: '0.000',
        theoreticalKg: '0.000',
        differenceKg: '0.000',
        wasteKg: '0.000',
        wastePct: null,
        overStandard: false,
      },
    });
    const range = { from: '2026-09-01', to: '2026-09-30' };

    await controller.inventoryValuationXlsxFile({ businessLine: 'drywall' }, {}, fakeResponse());
    expect(inventoryValuation.valuation).toHaveBeenLastCalledWith({ businessLine: 'drywall' });

    const margin = fakeResponse();
    await controller.salesMarginXlsxFile({ ...range, businessLine: 'services' }, {}, margin);
    expect(salesMargin.salesMargin).toHaveBeenLastCalledWith({
      ...range,
      businessLine: 'services',
    });
    expect(margin.headers['Content-Disposition']).toBe(
      'attachment; filename="ventas-margen-2026-08-01-a-2026-08-31-services.xlsx"',
    );

    const material = { ...range, businessLine: 'drywall' as const, kind: 'PERFIL' as const };
    await controller.salesByMaterialXlsxFile(material, {}, fakeResponse());
    expect(salesByMaterial.report).toHaveBeenLastCalledWith(material);

    const waste = fakeResponse();
    await controller.coilWasteXlsxFile({ ...range, businessLine: 'drywall' }, {}, waste);
    expect(coilWaste.report).toHaveBeenLastCalledWith({ ...range, businessLine: 'drywall' });
    expect(waste.headers['Content-Disposition']).toBe(
      'attachment; filename="merma-por-bobina-2026-09-01-a-2026-09-30-drywall.xlsx"',
    );
  });

  it('cc40 (D-588): cada Excel con buscador recibe la búsqueda y la dice al pie', async () => {
    const t = build();
    const zeroCoils = { openingKg: '0', weightKg: '0', closingKg: '0', closingValuePen: null };
    t.reports.coilsByMonth.mockResolvedValue({
      month: '2026-09',
      businessLine: null,
      sealed: { rows: [], totals: zeroCoils },
      opened: { rows: [], totals: zeroCoils },
      flow: { openingKg: '0', entriesKg: '0', exitsKg: '0', closingKg: '0' },
      finished: { count: 0, consumedKg: '0' },
      annulledWithOpening: { count: 0, openingKg: '0' },
      totals: zeroCoils,
    });
    t.receivablesAging.report.mockResolvedValue({
      asOf: '2026-09-30',
      sellerId: null,
      sellers: [],
      customers: [],
      totals: {
        balancePen: '0',
        buckets: { CURRENT: '0', D1_30: '0', D31_60: '0', D61_90: '0', OVER_90: '0' },
        documentCount: 0,
        customerCount: 0,
      },
    });
    const figures = {
      theoreticalKg: '0',
      consumedKg: '0',
      trimKg: '0',
      wastePct: null,
      overStandard: false,
      materialCostPen: null,
      trimCostPen: null,
    };
    t.productionSummary.report.mockResolvedValue({
      from: '2026-09-01',
      to: '2026-09-30',
      businessLine: 'metallic-roofing',
      standardPct: '1.00',
      withCosts: false,
      groups: [],
      totals: { orderCount: 0, ...figures, unattributedKg: '0' },
    });
    t.coilWaste.report.mockResolvedValue({
      from: '2026-09-01',
      to: '2026-09-30',
      businessLine: 'metallic-roofing',
      standardPct: '1.00',
      rows: [],
      totals: {
        coilCount: 0,
        consumedKg: '0',
        trimKg: '0',
        closeAdjustmentKg: '0',
        manualScrapKg: '0',
        comparableCoilCount: 0,
        comparableConsumedKg: '0',
        theoreticalKg: '0',
        differenceKg: '0',
        wasteKg: '0',
        wastePct: null,
        overStandard: false,
      },
    });
    const range = { from: '2026-09-01', to: '2026-09-30' };
    const search = { search: 'álamos' };
    const sheets = (res: { body: unknown }) => {
      const book = XLSX.read(res.body, { type: 'buffer' });
      return book.SheetNames.flatMap((n) =>
        XLSX.utils.sheet_to_json<unknown[]>(book.Sheets[n]!, { header: 1 }),
      );
    };
    const noted = (res: { body: unknown }) =>
      sheets(res).some((r) => typeof r[0] === 'string' && r[0].startsWith('Búsqueda «álamos»'));

    const calls: [string, (res: Response) => Promise<void>][] = [
      ['bobinas', (res) => t.controller.coilsXlsxFile(actor(Role.ADMINISTRADOR), {}, search, res)],
      ['inventario', (res) => t.controller.inventoryValuationXlsxFile({}, search, res)],
      ['margen', (res) => t.controller.salesMarginXlsxFile(range, search, res)],
      ['material', (res) => t.controller.salesByMaterialXlsxFile(range, search, res)],
      ['cxc', (res) => t.controller.receivablesAgingXlsxFile({}, search, res)],
      ['merma', (res) => t.controller.coilWasteXlsxFile(range, search, res)],
      [
        'producción',
        (res) =>
          t.controller.productionSummaryXlsxFile(
            range,
            actor(Role.ADMINISTRADOR),
            { ...search, ver: 'pedido' },
            res,
          ),
      ],
    ];
    for (const [name, call] of calls) {
      const res = fakeResponse();
      await call(res);
      expect({ name, noted: noted(res) }).toEqual({ name, noted: true });
    }
  });

  it('la rentabilidad de un comprobante delega en su servicio (C06)', async () => {
    const { controller, documentProfitability } = build();
    const id = '0b6f3c1e-2a4d-4e8f-9a1b-3c5d7e9f1a2b';
    await expect(controller.documentProfitabilityReport(id)).resolves.toEqual({ applies: true });
    expect(documentProfitability.profitability).toHaveBeenCalledWith(id);
  });

  it('el xlsx de margen usa el mismo rango que la pantalla', async () => {
    const { controller, salesMargin } = build();
    const res = fakeResponse();
    const query = { from: '2026-08-01', to: '2026-08-31' };
    await controller.salesMarginXlsxFile(query, {}, res);
    expect(salesMargin.salesMargin).toHaveBeenCalledTimes(1);
    expect(salesMargin.salesMargin).toHaveBeenCalledWith(query);
    expect(res.headers['Content-Disposition']).toMatch(/^attachment; filename=".+\.xlsx"$/);
  });

  it('ventas por material: JSON y xlsx con los mismos filtros, del mismo servicio (D-354)', async () => {
    const { controller, salesByMaterial } = build();
    const query = { from: '2026-09-01', to: '2026-09-30', kind: 'PLANCHA' as const };
    await expect(controller.salesByMaterialReport(query)).resolves.toBe(BY_MATERIAL);
    const res = fakeResponse();
    await controller.salesByMaterialXlsxFile(query, {}, res);
    expect(salesByMaterial.report).toHaveBeenCalledTimes(2);
    expect(salesByMaterial.report).toHaveBeenLastCalledWith(query);
    expect(res.headers['Content-Disposition']).toBe(
      'attachment; filename="ventas-por-material-2026-09-01-a-2026-09-30.xlsx"',
    );
    expect(Buffer.isBuffer(res.body)).toBe(true);
  });

  it('el xlsx del kardex PEPS pide el ítem y el rango y viaja como adjunto (D-279)', async () => {
    const { controller, kardexPeps } = build();
    const res = fakeResponse();
    const query = {
      itemType: 'COIL' as const,
      itemId: '11111111-1111-1111-1111-111111111111',
      from: '2026-09-01',
      to: '2026-09-30',
    };
    await controller.kardexPepsXlsxFile(query, res);
    expect(kardexPeps.report).toHaveBeenCalledWith(query);
    expect(res.headers['Content-Disposition']).toBe(
      'attachment; filename="kardex-peps-BOB-001-2026-09-01-2026-09-30.xlsx"',
    );
  });

  it('el PEPS en JSON sale del mismo reporte que el Excel (D-296)', async () => {
    const { controller, kardexPeps } = build();
    const query = {
      itemType: 'COIL' as const,
      itemId: '11111111-1111-1111-1111-111111111111',
      from: '2026-09-01',
      to: '2026-09-30',
    };
    const dto = await controller.kardexPepsJson(query);
    expect(kardexPeps.report).toHaveBeenCalledWith(query);
    expect(dto).toMatchObject({ itemCode: 'BOB-001', from: '2026-09-01', rows: [] });
  });

  it('el Excel del kardex con el formato del cliente pide la hoja y viaja como adjunto (D-298)', async () => {
    const { controller, kardexSheet } = build();
    kardexSheet.sheet.mockResolvedValue({
      method: 'AVERAGE',
      itemCode: 'BOB-001',
      itemDescription: 'Bobina',
      from: '2026-09-01',
      to: '2026-09-30',
      unit: 'KGM',
      rows: [],
    });
    const res = fakeResponse();
    const query = {
      itemType: 'COIL' as const,
      itemId: '11111111-1111-1111-1111-111111111111',
      from: '2026-09-01',
      to: '2026-09-30',
      method: 'AVERAGE' as const,
    };
    await controller.kardexSheetXlsxFile(query, res);
    expect(kardexSheet.sheet).toHaveBeenCalledWith(query);
    expect(res.headers['Content-Disposition']).toBe(
      'attachment; filename="kardex-average-BOB-001-2026-09-01-2026-09-30.xlsx"',
    );
  });
});
