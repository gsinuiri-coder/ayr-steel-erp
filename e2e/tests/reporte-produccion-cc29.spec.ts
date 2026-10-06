import { expect, test, type APIRequestContext } from '@playwright/test';
import {
  COIL_REPORT_LINES,
  businessToday,
  sum,
  toDecimal,
  type InventoryMovementDto,
  type PaginatedResult,
  type ProductionSummaryDto,
} from '@ayr/shared';
import { adminApi, createUser, getJson, postJson } from '../helpers/api';
import { loginAndSetPassword, openSidebarGroup } from '../helpers/ui';
import {
  apiAs,
  deactivateTrail,
  purgeProductionOrder,
  setupScenario,
  type ProductionOrderDto,
} from '../helpers/production';

/**
 * cc29 (M2, D-464, D-468) — reporte de producción por OP.
 *
 * - Los kg cuadran con el kardex de producción del rango (el criterio del E2E de merma de cc25):
 *   lo salido de las filas, más lo que no apunta a un reporte, es la suma de las salidas
 *   `PRODUCTION` vivas de la línea.
 * - Una OP de drywall con su reporte y su cierre: teórico, salido y merma de proceso por OP, y el
 *   detalle por bobina.
 * - El supervisor de planta lo ve, sin costos; el Excel sale; menú y pestañas en la URL.
 *
 * Crea compras, flejes y órdenes: nunca contra producción (D-126, regla dura 9).
 */
const isProduction = !!process.env.E2E_BASE_URL;
test.skip(isProduction, 'Crea datos de planta: nunca contra producción (D-126, regla dura 9).');
test.describe.configure({ timeout: 300_000 });

async function coilMovements(
  api: APIRequestContext,
  filter: string,
  from: string,
  to: string,
): Promise<InventoryMovementDto[]> {
  const out: InventoryMovementDto[] = [];
  for (let page = 1; page <= 50; page += 1) {
    const res = await getJson<PaginatedResult<InventoryMovementDto>>(
      api,
      `/api/inventory/movements?itemType=COIL&${filter}&from=${from}&to=${to}&page=${page}&pageSize=200`,
    );
    out.push(...res.items);
    if (out.length >= res.total || res.items.length === 0) break;
  }
  return out;
}

function liveProductionKg(movements: InventoryMovementDto[]): string {
  return sum(
    movements
      .filter(
        (m) => m.refType === 'PRODUCTION' && m.reversalOfId === null && m.reversedById === null,
      )
      .map((m) => (m.type === 'IN' ? toDecimal(m.qty).negated() : toDecimal(m.qty))),
  ).toFixed(3);
}

test('reporte de producción: una OP de drywall con su reporte y su cierre, y los kg del kardex', async ({
  page,
  baseURL,
}) => {
  const api = await adminApi(baseURL!);
  const scenario = await setupScenario(api);
  const strip = scenario.strips[0]!;
  const today = businessToday();
  const order = await postJson<ProductionOrderDto & { code: string }>(api, '/api/production', {
    productId: scenario.product.id,
  });
  try {
    await postJson(api, `/api/production/${order.id}/consume`, { coilId: strip.id });
    // 600 piezas × 2 kg = 1 200 kg de los 2 400 kg del fleje; al cerrar, los otros 1 200 kg son
    // la merma de proceso (D-057).
    await postJson(api, `/api/production/${order.id}/report`, { pieces: 600 });
    await postJson(api, `/api/production/${order.id}/close`, {
      reason: 'Corrida corta de prueba (E2E cc29)',
    });

    const range = `from=${today}&to=${today}`;
    const report = await getJson<ProductionSummaryDto>(
      api,
      `/api/reports/production-summary?${range}&businessLine=drywall`,
    );
    expect(report.withCosts).toBe(true);
    const row = report.groups
      .flatMap((g) => g.orders)
      .find((o) => o.productionOrderId === order.id);
    expect(row).toMatchObject({
      code: order.code,
      salesOrderCode: null,
      quantity: '600',
      quantityUnit: 'pzs',
      reportCount: 1,
      theoreticalKg: '1200.000',
      consumedKg: '1200.000',
      trimKg: '1200.000',
      wastePct: '100.00',
      overStandard: true,
    });
    expect(row!.coils).toEqual([
      expect.objectContaining({ coilId: strip.id, consumedKg: '1200.000', trimKg: '1200.000' }),
    ]);
    expect(row!.materialCostPen).not.toBeNull();

    // Los kg cuadran con el kardex de producción del rango, en las dos pestañas.
    for (const line of COIL_REPORT_LINES) {
      const lineReport = await getJson<ProductionSummaryDto>(
        api,
        `/api/reports/production-summary?${range}&businessLine=${line}`,
      );
      const kardex = await coilMovements(api, `businessLine=${line}`, today, today);
      expect(
        toDecimal(lineReport.totals.consumedKg).plus(lineReport.totals.unattributedKg).toFixed(3),
        line,
      ).toBe(liveProductionKg(kardex));
      expect(
        sum(lineReport.groups.flatMap((g) => g.orders).map((o) => o.consumedKg)).toFixed(3),
      ).toBe(lineReport.totals.consumedKg);
    }

    // El supervisor de planta lo ve, sin costos; el Excel sale para los dos.
    const supervisor = await createUser(api, 'SUPERVISOR_PLANTA');
    const plantApi = await apiAs(baseURL!, supervisor);
    const plant = await getJson<ProductionSummaryDto>(
      plantApi,
      `/api/reports/production-summary?${range}&businessLine=drywall`,
    );
    expect(plant.withCosts).toBe(false);
    expect(plant.totals.materialCostPen).toBeNull();
    const plantRow = plant.groups.flatMap((g) => g.orders).find((o) => o.code === order.code);
    expect(plantRow).toMatchObject({ consumedKg: '1200.000', materialCostPen: null });
    for (const ctx of [api, plantApi]) {
      const xlsx = await ctx.get(
        `/api/reports/production-summary/xlsx?${range}&businessLine=drywall`,
      );
      expect(xlsx.status()).toBe(200);
      expect(xlsx.headers()['content-disposition']).toContain(`produccion-drywall-${today}`);
    }
    expect(
      (await api.get(`/api/reports/production-summary?${range}&businessLine=services`)).status(),
    ).toBe(400);

    // En pantalla, como supervisor: el menú, las pestañas en la URL y la fila de la OP.
    const viewer = await createUser(api, 'SUPERVISOR_PLANTA');
    await loginAndSetPassword(page, viewer, 'ClaveSupervisorE2E-2026');
    await openSidebarGroup(page, 'Reportes');
    await expect(page.getByRole('link', { name: 'Reporte de producción' })).toBeVisible({
      timeout: 60_000,
    });
    await page.goto(`/reportes/produccion?${range}`);
    await expect(page.getByRole('heading', { name: 'Reporte de producción' })).toBeVisible();
    await page
      .getByTestId('pestanas-linea')
      .getByRole('tab', { name: 'Drywall', exact: true })
      .click();
    await expect(page).toHaveURL(`/reportes/produccion?${range}&linea=drywall`);
    const opRow = page.getByTestId('produccion-op').filter({ hasText: order.code });
    await expect(opRow).toContainText('600 pzs');
    await expect(opRow).toContainText('repartido en orden de montaje');
    await expect(page.getByRole('columnheader', { name: 'Costo salido' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Descargar Excel' })).toBeVisible();
  } finally {
    await purgeProductionOrder(api, order.id).catch(() => undefined);
    await deactivateTrail(api, {
      cuttingOrderId: scenario.cuttingOrderId,
      motherId: scenario.mother.id,
      purchaseId: scenario.purchaseId,
      supplierId: scenario.supplier.id,
      finish: scenario.finish,
      productId: scenario.product.id,
    });
  }
});
