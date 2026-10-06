import { expect, test } from '@playwright/test';
import { adminApi, createUser, getJson, postJson } from '../helpers/api';
import { loginAndSetPassword } from '../helpers/ui';
import {
  balanceOf,
  deactivateTrail,
  postExpectingError,
  purgeProductionOrder,
  setupScenario,
  today,
  type ProductionOrderDto,
} from '../helpers/production';

/**
 * cc29 (D-465) — el reporte de drywall pasado el 1 % entra con la casilla de D-389, igual que
 * coberturas, desde el panel de `/planta` y con un supervisor de planta (cualquier rol que hoy
 * reporta). Se mide contra la suma de los flejes montados.
 *
 * Escenario: fleje de 2 400 kg, perfil de 2 kg por pieza. 1 230 piezas = 2 460 kg: 60 kg más que lo
 * montado, 2,44 % del teórico (hacia arriba). Sin casilla no se guarda; con la casilla y el motivo
 * entra, el fleje queda en 0 (lo que sale se topa en lo montado), el reporte lleva la etiqueta
 * «Fuera de tolerancia» y el reporte de merma la ve.
 *
 * Crea compras, flejes y órdenes: nunca contra producción (D-126, regla dura 9).
 */

const isProduction = !!process.env.E2E_BASE_URL;
test.skip(isProduction, 'Crea datos de planta: nunca contra producción (D-126, regla dura 9).');
test.describe.configure({ timeout: 300_000 });

interface ReportWithOverride {
  id: string;
  pieces: number;
  rawMaterialWarning: string | null;
  toleranceOverride: { label: string; excessKg: string; excessPct: string } | null;
}

test('drywall: pasado el 1 %, el supervisor confirma con la casilla y el motivo; sale lo montado y queda la etiqueta', async ({
  page,
  baseURL,
}) => {
  const api = await adminApi(baseURL!);
  const scenario = await setupScenario(api);
  const strip = scenario.strips[0]!;
  const order = await postJson<ProductionOrderDto & { code: string }>(api, '/api/production', {
    productId: scenario.product.id,
  });
  try {
    await postJson(api, `/api/production/${order.id}/consume`, { coilId: strip.id });

    // Por API, sin casilla: 400 con el código y las cifras.
    const res = await api.post(`/api/production/${order.id}/report`, { data: { pieces: 1230 } });
    expect(res.status()).toBe(400);
    expect(await res.json()).toMatchObject({
      code: 'TOLERANCE_OVERRIDE_REQUIRED',
      excess: {
        theoreticalKg: '2460.000',
        availableKg: '2400.000',
        excessKg: '60.000',
        excessPct: '2.44',
        severe: false,
      },
    });
    // «Otro» sin texto no pasa la validación.
    const other = await postExpectingError(api, `/api/production/${order.id}/report`, {
      pieces: 1230,
      toleranceOverride: { reason: 'OTHER' },
    });
    expect(other.status).toBe(400);

    // En el panel de /planta: el aviso aparece al tipear, sin ir al API, y bloquea hasta marcar.
    const supervisor = await createUser(api, 'SUPERVISOR_PLANTA');
    await loginAndSetPassword(page, supervisor, 'ClaveSupervisorE2E-2026');
    await page.goto(`/planta?op=${order.id}`);
    const panel = page.locator(`#panel-${order.id}`);
    await panel.getByLabel(`Piezas buenas de ${order.code}`).fill('1230', { timeout: 60_000 });
    const warning = panel.getByTestId('tolerance-override');
    await expect(warning).toContainText('fuera de tolerancia');
    await expect(warning).toContainText('2.44 % del teórico');
    await expect(warning).toContainText('los flejes quedan en 0');
    const save = panel.getByRole('button', { name: `Guardar ${order.code}` });
    await expect(save).toBeDisabled();

    await warning
      .getByLabel(`Confirmar las piezas reportadas de ${order.code} fuera de tolerancia`)
      .check();
    const reason = warning.getByLabel(`Motivo de las piezas reportadas de ${order.code}`, {
      exact: true,
    });
    // Los cuatro motivos del dueño.
    await expect(reason.locator('option')).toHaveText([
      'Elige el motivo…',
      'Fleje más liviano que el nominal',
      'Fleje más pesado que el nominal',
      'Peso por pieza del SKU desactualizado',
      'Otro',
    ]);
    await expect(save).toBeDisabled();
    await reason.selectOption({ label: 'Peso por pieza del SKU desactualizado' });
    await expect(save).toBeEnabled();
    await save.click();
    await expect(page.getByText('Reportadas las piezas: 1230 en total')).toBeVisible();
    await expect(warning).toBeHidden();

    // Lo que sale del kardex se topa en lo montado: el fleje queda en 0.
    expect((await balanceOf(api, 'COIL', strip.id)).qty).toBe('0.000');
    const after = await getJson<{ reports: ReportWithOverride[] }>(
      api,
      `/api/production/${order.id}`,
    );
    expect(after.reports).toHaveLength(1);
    expect(after.reports[0]).toMatchObject({
      pieces: 1230,
      toleranceOverride: {
        label: 'Peso por pieza del SKU desactualizado',
        excessKg: '60.000',
        excessPct: '2.44',
      },
    });
    expect(after.reports[0]!.rawMaterialWarning).toContain(
      'Fuera de tolerancia, confirmado con la casilla: Peso por pieza del SKU desactualizado.',
    );

    // La acción de auditoría propia de drywall.
    const audit = await getJson<{ items: { action: string; after: Record<string, unknown> }[] }>(
      api,
      `/api/audit?entityType=production_orders&entityId=${order.id}`,
    );
    const entry = audit.items.find(
      (i) => i.action === 'production.drywall.report-tolerance-override',
    );
    expect(entry?.after).toMatchObject({
      reportId: after.reports[0]!.id,
      theoreticalKg: '2460.000',
      realKg: '2400.000',
      differenceKg: '60.000',
      differencePct: '2.44',
      reason: 'STALE_PIECE_WEIGHT',
      strips: [{ coilId: strip.id, kg: '2400.000' }],
    });

    // El reporte de merma (pestaña Drywall) lleva la etiqueta en la producción del fleje.
    const waste = await getJson<{
      rows: {
        coil: { code: string } | string;
        coilCode?: string;
        productions: { reportId: string | null; outOfTolerance: { label: string } | null }[];
      }[];
    }>(api, `/api/reports/coil-waste?from=${today()}&to=${today()}&businessLine=drywall`);
    const productions = waste.rows.flatMap((r) => r.productions);
    expect(
      productions.find((p) => p.reportId === after.reports[0]!.id)?.outOfTolerance,
    ).toMatchObject({ label: 'Peso por pieza del SKU desactualizado' });
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
