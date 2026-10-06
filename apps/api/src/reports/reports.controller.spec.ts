import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import { Role, type CoilMonthReportDto, type SalesByMaterialDto } from '@ayr/shared';
import type { RequestUser } from '../auth/auth.types';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import type { InventoryValuationService } from './inventory-valuation.service';
import type { KardexPepsService } from './kardex-peps.service';
import type { DocumentProfitabilityService } from './document-profitability.service';
import type { KardexSheetService } from './kardex-sheet.service';
import { ReportsController } from './reports.controller';
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
  const controller = new ReportsController(
    reports as unknown as ReportsService,
    inventoryValuation as unknown as InventoryValuationService,
    salesMargin as unknown as SalesMarginService,
    salesByMaterial as unknown as SalesByMaterialService,
    kardexPeps as unknown as KardexPepsService,
    kardexSheet as unknown as KardexSheetService,
    documentProfitability as unknown as DocumentProfitabilityService,
    receivablesAging as unknown as ReceivablesAgingService,
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
    expect(rolesOf('coils')).toEqual([Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA]);
    expect(rolesOf('coilsXlsxFile')).toEqual([Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA]);
    expect(rolesOf('coilsPdfFile')).toEqual([Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA]);
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
    await controller.coilsXlsxFile(actor(Role.SUPERVISOR_PLANTA), { month: '2026-08' }, res);
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
    await controller.inventoryValuationXlsxFile(res);
    expect(inventoryValuation.valuation).toHaveBeenCalledTimes(1);
    expect(res.headers['Content-Type']).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(res.headers['Content-Disposition']).toMatch(/^attachment; filename=".+\.xlsx"$/);
    expect(Buffer.isBuffer(res.body)).toBe(true);
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
    await controller.salesMarginXlsxFile(query, res);
    expect(salesMargin.salesMargin).toHaveBeenCalledTimes(1);
    expect(salesMargin.salesMargin).toHaveBeenCalledWith(query);
    expect(res.headers['Content-Disposition']).toMatch(/^attachment; filename=".+\.xlsx"$/);
  });

  it('ventas por material: JSON y xlsx con los mismos filtros, del mismo servicio (D-354)', async () => {
    const { controller, salesByMaterial } = build();
    const query = { from: '2026-09-01', to: '2026-09-30', kind: 'PLANCHA' as const };
    await expect(controller.salesByMaterialReport(query)).resolves.toBe(BY_MATERIAL);
    const res = fakeResponse();
    await controller.salesByMaterialXlsxFile(query, res);
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
