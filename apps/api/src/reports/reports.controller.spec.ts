import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import { Role } from '@ayr/shared';
import type { RequestUser } from '../auth/auth.types';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import type { InventoryValuationService } from './inventory-valuation.service';
import { ReportsController } from './reports.controller';
import type { ReportsService } from './reports.service';
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
  totals: { coilValuePen: '0.00', productValuePen: '0.00', totalValuePen: '0.00' },
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

function build() {
  const reports = { coilsByMonth: jest.fn().mockResolvedValue({ rows: [] }) };
  const inventoryValuation = { valuation: jest.fn().mockResolvedValue(VALUATION) };
  const salesMargin = { salesMargin: jest.fn().mockResolvedValue(MARGIN) };
  const controller = new ReportsController(
    reports as unknown as ReportsService,
    inventoryValuation as unknown as InventoryValuationService,
    salesMargin as unknown as SalesMarginService,
  );
  return { controller, reports, inventoryValuation, salesMargin };
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
    expect(rolesOf('coils')).toEqual([Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA]);
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

  it('las rutas JSON devuelven el DTO del servicio tal cual', async () => {
    const { controller, salesMargin } = build();
    await expect(controller.inventoryValuationReport()).resolves.toBe(VALUATION);
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

  it('el xlsx de margen usa el mismo rango que la pantalla', async () => {
    const { controller, salesMargin } = build();
    const res = fakeResponse();
    const query = { from: '2026-08-01', to: '2026-08-31' };
    await controller.salesMarginXlsxFile(query, res);
    expect(salesMargin.salesMargin).toHaveBeenCalledTimes(1);
    expect(salesMargin.salesMargin).toHaveBeenCalledWith(query);
    expect(res.headers['Content-Disposition']).toMatch(/^attachment; filename=".+\.xlsx"$/);
  });
});
