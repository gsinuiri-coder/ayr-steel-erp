import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { adminApi, createUser, getJson, postJson, type CreatedUser } from '../helpers/api';
import { apiAs, createCuttingSupplier, ROLE_PASSWORD, today } from '../helpers/production';
import { createCustomer } from '../helpers/sales';
import {
  buyRoofingCoil,
  createColor,
  createRoofingFinish,
  createRoofingProduct,
  mountCoil,
  purgeRoofingTrail,
  reservationsOf,
} from '../helpers/roofing';

/**
 * D-388 — la casilla del administrador para pasar la tolerancia del 1 % en el reporte de
 * coberturas, con el caso real: bobina de 4 184 kg, 428 planchas de 3,60 m (1 540,8 m).
 *
 * Geometría: 1 220 mm × 0,28 mm con densidad 8 (× 1,01 de la merma estándar) = 2,7601 kg/m, el
 * kilo por metro del caso. El teórico es 4 252,805 kg: 68,805 kg (1,62 %) más que lo montado.
 * Hoy el reporte se bloquea; con la casilla entra, consume los 4 184 kg montados (el saldo, no
 * el teórico), «Ejecutar y cerrar» termina la bobina en 0 (D-360) y todo es reversible.
 *
 * Crea compras, bobinas y órdenes: nunca contra producción (D-126, regla dura 9).
 */

const isProduction = !!process.env.E2E_BASE_URL;
test.skip(isProduction, 'Crea datos de planta: nunca contra producción (D-126, regla dura 9).');
test.describe.configure({ timeout: 300_000 });

const COIL_KG = '4184';
const WIDTH = '1220';
const THICKNESS = '0.28';
const PIECE_MM = '3600.00';
const PIECES = 428;
const PIECES_OVER_5 = 445;

interface DraftDto {
  id: string;
  rowNumber: number;
  outOfTolerance: { excessKg: string; excessPct: string; availableKg: string } | null;
}
interface OrderDto {
  id: string;
  code: string;
  status: string;
  reports: {
    id: string;
    status: string;
    coils: { kg: string }[];
    rawMaterialWarning: string | null;
    toleranceOverride: { label: string; excessPct: string; excessKg: string } | null;
  }[];
}
interface CoilState {
  status: string;
  availableKg: string;
}

interface Scenario {
  supplierId: string;
  finishId: string;
  colorId: string;
  productId: string;
  customerId: string;
  coilIds: string[];
  purchaseIds: string[];
  quotationIds: string[];
  salesOrderIds: string[];
  productionOrderIds: string[];
}

async function setup(api: APIRequestContext): Promise<Scenario> {
  const color = await createColor(api);
  const [supplier, finish, customer] = await Promise.all([
    createCuttingSupplier(api),
    createRoofingFinish(api, { colorId: color.id }),
    createCustomer(api),
  ]);
  const { product } = await createRoofingProduct(api, {
    finishId: finish.id,
    colorId: color.id,
    thicknessMm: THICKNESS,
    catalogWidthMm: WIDTH,
    pieceLengthMm: PIECE_MM,
  });
  return {
    supplierId: supplier.id,
    finishId: finish.id,
    colorId: color.id,
    productId: product.id,
    customerId: customer.id,
    coilIds: [],
    purchaseIds: [],
    quotationIds: [],
    salesOrderIds: [],
    productionOrderIds: [],
  };
}

/**
 * Una bobina de 4 184 kg, un pedido de `qty` planchas de 3,60 m y su OP con la bobina montada
 * entera. Una cobertura se produce contra el pedido (D-171); el pedido pide más kilos teóricos
 * que la bobina, así que el administrador lo confirma con faltante (D-341), como en planta.
 */
async function orderWithCoil(
  api: APIRequestContext,
  s: Scenario,
  qty: number,
): Promise<{ order: OrderDto; coilId: string }> {
  const { coil, purchaseId } = await buyRoofingCoil(api, {
    supplierId: s.supplierId,
    finishId: s.finishId,
    colorId: s.colorId,
    weightKg: COIL_KG,
    widthMm: WIDTH,
    thicknessMm: THICKNESS,
  });
  s.coilIds.push(coil.id);
  s.purchaseIds.push(purchaseId);
  const quotation = await postJson<{ id: string }>(api, '/api/sales/quotations', {
    customerId: s.customerId,
    issueDate: today(),
    // La plancha de catálogo se cotiza en unidades (NIU), sin detalle de largos.
    items: [{ productId: s.productId, qty: String(qty), unitPricePen: '120' }],
  });
  s.quotationIds.push(quotation.id);
  const salesOrder = await postJson<{ id: string }>(
    api,
    `/api/sales/quotations/${quotation.id}/confirm`,
    { confirmShortfall: true, shortfallReason: 'E2E D-388: la bobina real pesa menos' },
  );
  s.salesOrderIds.push(salesOrder.id);
  const reservation = (await reservationsOf(api, salesOrder.id)).find(
    (r) => r.productionOrderId !== null,
  );
  expect(reservation, 'confirmar no dejó la OP en cola').toBeDefined();
  const orderId = reservation!.productionOrderId!;
  s.productionOrderIds.push(orderId);
  await mountCoil(api, orderId, { coilId: coil.id });
  return { order: await getJson<OrderDto>(api, `/api/production/${orderId}`), coilId: coil.id };
}

const draftsPath = (orderId: string) => `/api/production/roofing/${orderId}/drafts`;

async function addDraft(api: APIRequestContext, orderId: string, qty: number) {
  return api.post(draftsPath(orderId), {
    data: { pieces: [{ lengthMm: PIECE_MM, qty }], idempotencyKey: randomUUID() },
  });
}

async function commit(api: APIRequestContext, orderId: string, body: Record<string, unknown>) {
  return api.post(`${draftsPath(orderId)}/commit`, {
    data: { ...body, idempotencyKey: randomUUID() },
  });
}

async function login(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await expect(page).toHaveURL(/\/$/, { timeout: 60_000 });
}

test.describe('D-388 — fuera de tolerancia con la casilla del administrador', () => {
  let api: APIRequestContext;
  let supervisor: CreatedUser;
  let supervisorApi: APIRequestContext;
  let s: Scenario;

  test.beforeAll(async ({ baseURL }) => {
    test.setTimeout(180_000);
    api = await adminApi(baseURL!);
    supervisor = await createUser(api, 'SUPERVISOR_PLANTA');
    supervisorApi = await apiAs(baseURL!, supervisor);
    s = await setup(api);
  });

  test.afterAll(async () => {
    test.setTimeout(240_000);
    await purgeRoofingTrail(api, {
      productionOrderIds: s.productionOrderIds,
      orderIds: s.salesOrderIds,
      quotationIds: s.quotationIds,
      coilIds: s.coilIds,
      purchaseIds: s.purchaseIds,
      productIds: [s.productId],
      supplierId: s.supplierId,
      finishId: s.finishId,
      colorId: s.colorId,
    });
    await supervisorApi.dispose();
    await api.dispose();
  });

  test('el caso real: aceptado con casilla, consume los 4 184 kg, termina la bobina y se revierte', async () => {
    const { order, coilId } = await orderWithCoil(api, s, PIECES);

    // El borrador acepta la fila y la marca con las cifras del caso.
    const added = await addDraft(api, order.id, PIECES);
    expect(added.ok(), await added.text()).toBe(true);
    const [row] = (await added.json()) as DraftDto[];
    expect(row?.outOfTolerance).toMatchObject({
      excessKg: '68.805',
      excessPct: '1.62',
      availableKg: '4184.000',
    });

    // Rechazos: sin casilla (código propio), «Otro» sin texto, sin motivo, no administrador.
    const withoutOverride = await commit(api, order.id, { close: true });
    expect(withoutOverride.status()).toBe(400);
    const body = (await withoutOverride.json()) as {
      code?: string;
      message: string;
      excess?: { excessPct: string };
    };
    expect(body.code).toBe('TOLERANCE_OVERRIDE_REQUIRED');
    expect(body.message).toMatch(/^Fila 1: /);
    expect(body.excess?.excessPct).toBe('1.62');

    const otherWithoutText = await commit(api, order.id, {
      close: true,
      toleranceOverrides: [{ draftId: row!.id, reason: 'OTHER' }],
    });
    expect(otherWithoutText.status()).toBe(400);
    const noReason = await commit(api, order.id, {
      close: true,
      toleranceOverrides: [{ draftId: row!.id }],
    });
    expect(noReason.status()).toBe(400);
    // D-389: «Bobina más pesada» no explica un exceso hacia arriba.
    const heavier = await commit(supervisorApi, order.id, {
      close: true,
      toleranceOverrides: [{ draftId: row!.id, reason: 'HEAVIER_COIL' }],
    });
    expect(heavier.status()).toBe(400);
    // Nada se movió con los rechazos.
    expect((await getJson<CoilState>(api, `/api/coils/${coilId}`)).availableKg).toBe('4184.000');

    // Aceptado por un supervisor de planta (D-389: sin administrador): casilla + motivo,
    // «Ejecutar y cerrar».
    const accepted = await commit(supervisorApi, order.id, {
      close: true,
      toleranceOverrides: [
        { draftId: row!.id, reason: 'LIGHTER_COIL', detail: 'Pesó 4 184 kg en la balanza' },
      ],
    });
    expect(accepted.ok(), await accepted.text()).toBe(true);

    const coil = await getJson<CoilState>(api, `/api/coils/${coilId}`);
    expect(coil).toMatchObject({ availableKg: '0.000', status: 'CLOSED' });
    const closed = await getJson<OrderDto>(api, `/api/production/${order.id}`);
    expect(closed.status).toBe('CLOSED');
    const [report] = closed.reports.filter((r) => r.status === 'ACTIVE');
    // El consumo es lo montado, no el teórico.
    expect(report?.coils.map((c) => c.kg)).toEqual(['4184.000']);
    expect(report?.toleranceOverride).toMatchObject({
      label: 'Bobina más liviana que el nominal: Pesó 4 184 kg en la balanza',
      excessKg: '68.805',
      excessPct: '1.62',
    });
    expect(report?.rawMaterialWarning).toContain('Fuera de tolerancia, confirmado con la casilla');

    // La auditoría propia, en el historial de la orden.
    const audit = await getJson<{ items: { action: string; after: Record<string, unknown> }[] }>(
      api,
      `/api/audit?entityType=production_orders&entityId=${order.id}`,
    );
    const entry = audit.items.find(
      (e) => e.action === 'production.roofing.report-tolerance-override',
    );
    expect(entry?.after).toMatchObject({
      reportId: report?.id,
      coilId,
      theoreticalKg: '4252.805',
      realKg: '4184.000',
      differenceKg: '68.805',
      differencePct: '1.62',
      reason: 'LIGHTER_COIL',
      detail: 'Pesó 4 184 kg en la balanza',
    });

    // Reversa: reabrir la orden reabre la bobina; revertir el reporte devuelve los 4 184 kg.
    await postJson(api, `/api/production/roofing/${order.id}/reopen`, {
      reason: 'E2E D-388: deshacer el caso real',
    });
    expect((await getJson<CoilState>(api, `/api/coils/${coilId}`)).status).toBe('OPEN');
    await postJson(api, `/api/production/roofing/${order.id}/reports/${report!.id}/reverse`, {
      reason: 'E2E D-388: deshacer el caso real',
    });
    expect(await getJson<CoilState>(api, `/api/coils/${coilId}`)).toMatchObject({
      status: 'OPEN',
      availableKg: '4184.000',
    });
  });

  test('D-389: más del 5 % se acepta con la casilla, con el aviso fuerte, y se revierte', async () => {
    const { order, coilId } = await orderWithCoil(api, s, PIECES_OVER_5);
    // El borrador acepta la fila y la marca con el aviso fuerte (445 planchas: 5,68 %).
    const draft = await addDraft(api, order.id, PIECES_OVER_5);
    expect(draft.ok(), await draft.text()).toBe(true);
    const [row] = (await draft.json()) as (DraftDto & {
      outOfTolerance: { severe: boolean } | null;
    })[];
    expect(row?.outOfTolerance).toMatchObject({ severe: true });

    // Sin casilla, el rechazo trae el texto fuerte.
    const without = await commit(supervisorApi, order.id, {});
    expect(without.status()).toBe(400);
    const body = (await without.json()) as { code?: string; message: string };
    expect(body.code).toBe('TOLERANCE_OVERRIDE_REQUIRED');
    expect(body.message).toContain('Diferencia mayor al 5 %: revisa cantidad, largo y bobina');

    // Con la casilla entra (sin cerrar), topado en el saldo.
    const accepted = await commit(supervisorApi, order.id, {
      toleranceOverrides: [{ draftId: row!.id, reason: 'OTHER', detail: 'Bobina de prueba E2E' }],
    });
    expect(accepted.ok(), await accepted.text()).toBe(true);
    expect((await getJson<CoilState>(api, `/api/coils/${coilId}`)).availableKg).toBe('0.000');
    const [report] = (await getJson<OrderDto>(api, `/api/production/${order.id}`)).reports.filter(
      (r) => r.status === 'ACTIVE',
    );
    expect(report?.coils.map((c) => c.kg)).toEqual(['4184.000']);

    // La reversa del reporte devuelve los 4 184 kg.
    await postJson(api, `/api/production/roofing/${order.id}/reports/${report!.id}/reverse`, {
      reason: 'E2E D-389: revertir el reporte sobre 5 %',
    });
    expect((await getJson<CoilState>(api, `/api/coils/${coilId}`)).availableKg).toBe('4184.000');
  });

  test('en pantalla: el supervisor de planta marca la casilla y ejecuta (D-389)', async ({
    page,
  }) => {
    const { order, coilId } = await orderWithCoil(api, s, PIECES);
    const added = await addDraft(api, order.id, PIECES);
    expect(added.ok(), await added.text()).toBe(true);

    await login(page, supervisor.email, ROLE_PASSWORD);
    await page.goto(`/planta?op=${order.id}`);
    const panel = page.locator(`#panel-${order.id}`);
    const block = panel.getByTestId('tolerance-override');
    await expect(block).toContainText('68.805', { timeout: 60_000 });
    await expect(block).toContainText('1.62 %');
    await expect(block).not.toContainText('administrador');
    await expect(block).not.toContainText('Diferencia mayor');
    await expect(panel.getByRole('table', { name: `Borrador de ${order.code}` })).toContainText(
      'Fuera de tolerancia (1.62 %)',
    );
    const execute = panel.getByRole('button', {
      name: `Ejecutar el borrador y cerrar ${order.code}`,
    });
    await expect(execute).toBeDisabled();
    await block
      .getByRole('checkbox', { name: `Confirmar la fila 1 de ${order.code} fuera de tolerancia` })
      .click();
    await expect(execute).toBeDisabled();
    const reason = block.getByRole('combobox', { name: `Motivo de la fila 1 de ${order.code}` });
    // Solo los motivos que aplican a un exceso hacia arriba.
    await expect(reason.locator('option')).toHaveText([
      'Elige el motivo…',
      'Bobina más liviana que el nominal',
      'Otro',
    ]);
    await reason.selectOption('OTHER');
    // «Otro» exige el texto.
    await expect(execute).toBeDisabled();
    await block
      .getByRole('textbox', { name: `Detalle del motivo de la fila 1 de ${order.code}` })
      .fill('Rollo con espesor real menor');
    await expect(execute).toBeEnabled();
    await execute.click();
    await expect(page.getByText(`${order.code}: borrador ejecutado y orden cerrada`)).toBeVisible({
      timeout: 60_000,
    });

    expect(await getJson<CoilState>(api, `/api/coils/${coilId}`)).toMatchObject({
      availableKg: '0.000',
      status: 'CLOSED',
    });

    // El detalle de la orden lo distingue a la vista.
    await page.goto(`/produccion/${order.id}`);
    const tag = page.getByTestId('report-tolerance-override');
    await expect(tag).toContainText('Fuera de tolerancia', { timeout: 60_000 });
    await expect(tag).toContainText('1.62 % · Rollo con espesor real menor');
  });
});
