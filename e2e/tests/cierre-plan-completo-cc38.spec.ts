import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { canonicalAccessorySku } from '@ayr/shared';
import { adminApi, adminCredentials, getJson, postJson } from '../helpers/api';
import { today, type ProductionOrderDto } from '../helpers/production';
import { createCustomer, createQuotationWithLines } from '../helpers/sales';
import {
  buyRoofingCoil,
  ROOFING_LINE,
  mountCoil,
  pieces,
  purgeRoofingTrail,
  quoteAndOrderLines,
  reservationsOf,
  setupRoofingScenario,
} from '../helpers/roofing';
import { openQueuedOrder } from '../helpers/ui';

/**
 * cc38 (D-573..D-576) — la OP se cierra solo con el plan completo y nunca registra más que él.
 *
 * Contra la base real: los tres caminos de cierre (close, report-and-close y el commit del
 * borrador con close=true) y sus vistas previas rechazan el plan incompleto sin escribir nada; el
 * exceso se rechaza en el reporte, en la fila del borrador y en el commit. En pantalla, el bloque
 * que se llena solo no viaja en ningún commit hasta confirmarlo, y «Registrar y cerrar» se apaga
 * mientras falte plan.
 *
 * Aritmética: 1 000 mm × 0.50 mm, densidad 8.0 y el 1 % de D-165 ⇒ 4.04 kg por metro.
 */
const allowWrites = !process.env.E2E_BASE_URL;
test.skip(!allowWrites, 'Crea compras, bobinas y producción: nunca contra producción (D-126).');
test.describe.configure({ timeout: 300_000 });

type Trail = Parameters<typeof purgeRoofingTrail>[1];

/** Un POST que tiene que fallar con 400 y exactamente ese mensaje. */
async function expectRejected(
  api: APIRequestContext,
  path: string,
  data: unknown,
  message: string,
): Promise<void> {
  const res = await api.post(path, { data });
  expect(res.status(), `${path} debía rechazarse`).toBe(400);
  const body = (await res.json()) as { message: string | string[] };
  expect(Array.isArray(body.message) ? body.message.join(' ') : body.message).toBe(message);
}

async function activeReports(api: APIRequestContext, opId: string): Promise<number> {
  const op = await getJson<ProductionOrderDto>(api, `/api/production/${opId}`);
  return op.reports.filter((r) => r.status === 'ACTIVE').length;
}

/** Una cobertura a medida con plan 10 × 4 m = 40 m y las bobinas montadas. */
async function aMedida(
  api: APIRequestContext,
  coils: number,
): Promise<{
  opId: string;
  opCode: string;
  orderId: string;
  coils: { id: string; code: string }[];
  trail: Trail;
}> {
  const scenario = await setupRoofingScenario(api, { weightKg: '2000' });
  const mounted = [
    { id: scenario.coil.id, code: scenario.coil.code, purchaseId: scenario.purchaseId },
  ];
  for (let i = 1; i < coils; i += 1) {
    const extra = await buyRoofingCoil(api, {
      supplierId: scenario.supplier.id,
      finishId: scenario.finish.id,
      colorId: scenario.color.id,
      weightKg: '2000',
    });
    mounted.push({ id: extra.coil.id, code: extra.coil.code, purchaseId: extra.purchaseId });
  }
  const customer = await createCustomer(api);
  const { quotation, order } = await quoteAndOrderLines(api, {
    customerId: customer.id,
    lines: [{ productId: scenario.product.id, rows: pieces([4, 10]) }],
  });
  const opId = order.reservations[0]!.productionOrderId!;
  for (const c of mounted) await mountCoil(api, opId, { coilId: c.id });
  const op = await getJson<ProductionOrderDto>(api, `/api/production/${opId}`);
  return {
    opId,
    opCode: op.code,
    orderId: order.id,
    coils: mounted,
    trail: {
      supplierId: scenario.supplier.id,
      finishId: scenario.finish.id,
      colorId: scenario.color.id,
      productIds: [scenario.product.id],
      coilIds: mounted.map((c) => c.id),
      purchaseIds: mounted.map((c) => c.purchaseId),
      productionOrderIds: [opId],
      orderIds: [order.id],
      quotationIds: [quotation.id],
    },
  };
}

test.describe('cc38 — el API (D-573, D-574)', () => {
  let api: APIRequestContext;
  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
  });
  test.afterAll(async () => {
    await api.dispose();
  });

  test('a medida: los tres caminos y sus vistas previas rechazan el plan incompleto sin escribir; el exceso, en reporte, fila y commit', async () => {
    const s = await aMedida(api, 1);
    const base = `/api/production/roofing/${s.opId}`;
    try {
      await postJson(api, `${base}/report`, { pieces: pieces([4, 6]) });
      expect(await activeReports(api, s.opId)).toBe(1);

      // D-573: close y su vista previa.
      await expectRejected(
        api,
        `${base}/close/preview`,
        {},
        'Para cerrar falta registrar 16.000 m del plan',
      );
      await expectRejected(
        api,
        `${base}/close`,
        {},
        'Para cerrar falta registrar 16.000 m del plan',
      );
      // report-and-close: cuenta lo que registra en el mismo acto y aun así falta.
      const partial = { pieces: pieces([4, 2]) };
      await expectRejected(
        api,
        `${base}/report-and-close/preview`,
        partial,
        'Para cerrar falta registrar 8.000 m del plan',
      );
      await expectRejected(
        api,
        `${base}/report-and-close`,
        partial,
        'Para cerrar falta registrar 8.000 m del plan',
      );
      expect(await activeReports(api, s.opId), 'el reporte de la mitad rechazada no quedó').toBe(1);

      // El commit del borrador con close=true (y su vista previa): el borrador queda intacto.
      await postJson(api, `${base}/drafts`, { pieces: pieces([4, 2]) });
      await expectRejected(
        api,
        `${base}/drafts/commit/preview`,
        { close: true },
        'Para cerrar falta registrar 8.000 m del plan',
      );
      await expectRejected(
        api,
        `${base}/drafts/commit`,
        { close: true },
        'Para cerrar falta registrar 8.000 m del plan',
      );
      const drafts = await getJson<{ id: string }[]>(api, `${base}/drafts`);
      expect(drafts).toHaveLength(1);
      expect(await activeReports(api, s.opId)).toBe(1);

      // D-574: una fila del borrador que pasaría el plan (6 + 2 + 3 = 11 planchas).
      await expectRejected(
        api,
        `${base}/drafts`,
        { pieces: pieces([4, 3]) },
        'Excede el plan en 4.000 m · ajusta el plan',
      );
      // Un reporte que lo pasaría (6 + 5 = 11 planchas).
      await expectRejected(
        api,
        `${base}/report`,
        { pieces: pieces([4, 5]) },
        'Excede el plan en 4.000 m · ajusta el plan',
      );
      // El commit: un reporte directo deja al borrador de más (6 + 3 + 2 = 11).
      await postJson(api, `${base}/report`, { pieces: pieces([4, 3]) });
      await expectRejected(
        api,
        `${base}/drafts/commit`,
        {},
        'Fila 1: Excede el plan en 4.000 m · ajusta el plan',
      );

      // Exacto: 9 + 1 = 10 planchas, se cierra.
      await api.put(`${base}/drafts/${drafts[0]!.id}`, { data: { pieces: pieces([4, 1]) } });
      await postJson(api, `${base}/drafts/commit`, { close: true });
      const op = await getJson<ProductionOrderDto>(api, `/api/production/${s.opId}`);
      expect(op.status).toBe('CLOSED');
    } finally {
      await purgeRoofingTrail(api, s.trail);
    }
  });

  test('plancha de catálogo: falta una plancha y no cierra; con todas, sí', async () => {
    const scenario = await setupRoofingScenario(api, { weightKg: '2000', pieceLengthMm: '3000' });
    const customer = await createCustomer(api);
    // D-161: la plancha se cotiza en unidades (NIU), sin detalle de largos.
    const quotation = await createQuotationWithLines(api, {
      customerId: customer.id,
      businessLine: ROOFING_LINE,
      items: [{ productId: scenario.product.id, qty: '5', valuePerMeterPen: '60.0000' }],
    });
    const order = await postJson<{ id: string }>(
      api,
      `/api/sales/quotations/${quotation.id}/confirm`,
      {},
    );
    const opId = (await reservationsOf(api, order.id)).find(
      (r) => r.productionOrderId,
    )?.productionOrderId;
    if (!opId) throw new Error('confirmar no dejó la OP de la plancha');
    const trail: Trail = {
      supplierId: scenario.supplier.id,
      finishId: scenario.finish.id,
      colorId: scenario.color.id,
      productIds: [scenario.product.id],
      coilIds: [scenario.coil.id],
      purchaseIds: [scenario.purchaseId],
      productionOrderIds: [opId],
      orderIds: [order.id],
      quotationIds: [quotation.id],
    };
    try {
      await mountCoil(api, opId, { coilId: scenario.coil.id });
      const base = `/api/production/roofing/${opId}`;
      await postJson(api, `${base}/report`, { pieces: pieces([3, 4]) });
      await expectRejected(
        api,
        `${base}/close`,
        {},
        'Para cerrar falta registrar 3.000 m del plan',
      );
      await postJson(api, `${base}/report-and-close`, { pieces: pieces([3, 1]) });
      expect((await getJson<ProductionOrderDto>(api, `/api/production/${opId}`)).status).toBe(
        'CLOSED',
      );
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });

  test('accesorio: se compara contra los metros de la orden; pasarlos se rechaza', async () => {
    const s = await setupRoofingScenario(api, { weightKg: '1000' });
    const customer = await createCustomer(api);
    const accessory = await postJson<{ id: string }>(api, '/api/catalog', {
      businessLineId: s.product.businessLineId,
      sku: canonicalAccessorySku(s.product.thicknessMm ?? '0.50', s.color.code),
      name: 'Accesorio E2E cc38',
      unit: 'MTR',
      source: 'MANUFACTURED',
      listPricePen: '30',
      finishId: s.product.finishId,
      colorId: s.product.colorId,
      thicknessMm: s.product.thicknessMm,
      widthMm: s.product.widthMm,
      roofingKind: 'ACCESORIO',
    });
    const quotation = await postJson<{ id: string }>(api, '/api/sales/quotations', {
      customerId: customer.id,
      issueDate: today(),
      items: [{ productId: accessory.id, qty: '20.000', unitPricePen: '60' }],
    });
    const order = await postJson<{ id: string }>(
      api,
      `/api/sales/quotations/${quotation.id}/confirm`,
      {},
    );
    const opId = (await reservationsOf(api, order.id)).find(
      (r) => r.productionOrderId,
    )?.productionOrderId;
    expect(opId, 'confirmar no dejó la OP en cola').toBeTruthy();
    const trail: Trail = {
      supplierId: s.supplier.id,
      finishId: s.finish.id,
      colorId: s.color.id,
      productIds: [s.product.id, accessory.id],
      coilIds: [s.coil.id],
      purchaseIds: [s.purchaseId],
      productionOrderIds: [opId!],
      orderIds: [order.id],
      quotationIds: [quotation.id],
    };
    try {
      await mountCoil(api, opId!, { coilId: s.coil.id });
      const base = `/api/production/roofing/${opId!}`;
      await postJson(api, `${base}/report`, { meters: '7.000' });
      await expectRejected(
        api,
        `${base}/report`,
        { meters: '14.000' },
        'Excede el plan en 1.000 m · ajusta el plan',
      );
      await expectRejected(
        api,
        `${base}/close`,
        {},
        'Para cerrar falta registrar 13.000 m del plan',
      );
      await postJson(api, `${base}/report-and-close`, { meters: '13.000' });
      expect((await getJson<ProductionOrderDto>(api, `/api/production/${opId!}`)).status).toBe(
        'CLOSED',
      );
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });
});

// ---------------------------------------------------------------------------
// Pantalla (D-575, D-576)
// ---------------------------------------------------------------------------

async function loginAsAdmin(page: Page): Promise<void> {
  const { email, password } = adminCredentials();
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await expect(page).toHaveURL(/\/(cambiar-contrasena)?$/, { timeout: 60_000 });
}

async function openOrder(
  page: Page,
  s: { orderId: string; opId: string; opCode: string },
): Promise<Locator> {
  await loginAsAdmin(page);
  await page.goto(`/planta?pedido=${s.orderId}`);
  await openQueuedOrder(page, s.opCode);
  const panel = page.locator(`#panel-${s.opId}`);
  await expect(panel.getByText('Plan y avance')).toBeVisible({ timeout: 60_000 });
  return panel;
}

async function waitSaved(panel: Locator): Promise<void> {
  await expect(panel.getByText('Todo lo escrito está guardado')).toBeVisible({ timeout: 30_000 });
}

test.describe('cc38 — la pantalla (D-575, D-576)', () => {
  let api: APIRequestContext;
  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
  });
  test.afterAll(async () => {
    await api.dispose();
  });

  test('el bloque llenado solo no viaja en el commit; la barra suma los tres tramos; cerrar se apaga mientras falte', async ({
    page,
  }) => {
    const s = await aMedida(api, 2);
    const [first, second] = s.coils as [{ id: string; code: string }, { id: string; code: string }];
    try {
      const panel = await openOrder(page, s);
      const a = panel.getByTestId(`bloque-${first.code}`);
      const b = panel.getByTestId(`bloque-${second.code}`);

      // Sin nada escrito, el último bloque se llena solo y queda marcado sin confirmar.
      await expect(b).toHaveAttribute('data-auto', 'sin-confirmar');
      await expect(b.getByText('Llenado solo · sin confirmar')).toBeVisible();
      await expect(
        panel.getByRole('button', { name: `Registrar producción de ${s.opCode}` }),
      ).toBeDisabled();

      // De la primera salieron 3: el bloque llenado solo baja a 7 y no cuenta en el borrador.
      await a.getByLabel(/Largo del corte 1 de/).selectOption('4.00');
      await a.getByLabel(/Planchas del corte 1 de/).fill('3');
      await expect(b.getByLabel(/Planchas del corte 1 de/)).toHaveValue('7');
      await waitSaved(panel);
      await expect(panel.getByTestId('tramo-registrado')).toContainText('Registrado 0.00 m');
      await expect(panel.getByTestId('tramo-borrador')).toContainText('12.00 m · 3 planchas');
      await expect(panel.getByTestId('tramo-falta')).toContainText('28.00 m · 7 planchas');

      await panel.getByRole('button', { name: `Registrar producción de ${s.opCode}` }).click();
      await expect
        .poll(
          async () =>
            (await getJson<ProductionOrderDto>(api, `/api/production/${s.opId}`)).reports.filter(
              (r) => r.status === 'ACTIVE',
            ).length,
          { timeout: 60_000 },
        )
        .toBe(1);
      const op = await getJson<ProductionOrderDto>(api, `/api/production/${s.opId}`);
      // Solo las 3 de la primera: las 7 del bloque llenado solo no se registraron.
      expect(op.reports.filter((r) => r.status === 'ACTIVE').map((r) => r.pieces)).toEqual([3]);
      await expect(panel.getByTestId('tramo-registrado')).toContainText('12.00 m · 3 planchas', {
        timeout: 60_000,
      });

      // «Vaciar»: falta plan y «Registrar y cerrar» se apaga con el motivo.
      await b.getByRole('button', { name: /^Vaciar / }).click();
      await expect(panel.getByTestId('aviso-cierre')).toContainText(
        'Para cerrar falta registrar 28.00 m',
      );
      await expect(panel.getByTestId('aviso-cierre')).toContainText('7 planchas: 4.00 m × 7');
      await expect(
        panel.getByRole('button', { name: `Registrar y cerrar ${s.opCode}` }),
      ).toBeDisabled();

      // Escrito a mano, cuenta como confirmado: se cierra sin la casilla.
      await b.getByLabel(/Largo del corte 1 de/).selectOption('4.00');
      await b.getByLabel(/Planchas del corte 1 de/).fill('7');
      await waitSaved(panel);
      await expect(b).not.toHaveAttribute('data-auto', 'sin-confirmar');
      await panel.getByRole('button', { name: `Registrar y cerrar ${s.opCode}` }).click();
      const preview = panel.getByTestId('que-va-a-pasar');
      await expect(preview).toContainText(`${s.opCode} queda cerrada con el plan completo`, {
        timeout: 60_000,
      });
      await preview.getByRole('button', { name: 'Confirmar: registrar y cerrar' }).click();
      await expect
        .poll(
          async () => (await getJson<ProductionOrderDto>(api, `/api/production/${s.opId}`)).status,
          { timeout: 60_000 },
        )
        .toBe('CLOSED');
    } finally {
      await purgeRoofingTrail(api, s.trail);
    }
  });

  test('«Registrar y cerrar» con el bloque llenado solo pide confirmarlo en «Qué va a pasar»', async ({
    page,
  }) => {
    const s = await aMedida(api, 1);
    const [only] = s.coils as [{ id: string; code: string }];
    try {
      const panel = await openOrder(page, s);
      await expect(panel.getByTestId('aviso-cierre')).toContainText(
        'Con el bloque confirmado, el plan queda completo',
      );
      await panel.getByRole('button', { name: `Registrar y cerrar ${s.opCode}` }).click();
      const ask = panel.getByTestId('confirmar-llenado-solo');
      await expect(ask).toContainText(
        `Incluye 10 planchas que se llenaron solas en la bobina ${only.code}`,
      );
      // Hasta marcar la casilla no se guardó nada en el borrador.
      expect(
        await getJson<unknown[]>(api, `/api/production/roofing/${s.opId}/drafts`),
      ).toHaveLength(0);
      await ask.getByRole('checkbox', { name: 'Confirmo que salieron' }).click();
      const preview = panel.getByTestId('que-va-a-pasar');
      await expect(preview).toContainText('Confirmo que salieron', { timeout: 60_000 });
      await expect(preview).toContainText(`${s.opCode} queda cerrada con el plan completo`);
      await preview.getByRole('button', { name: 'Confirmar: registrar y cerrar' }).click();
      await expect
        .poll(
          async () => (await getJson<ProductionOrderDto>(api, `/api/production/${s.opId}`)).status,
          { timeout: 60_000 },
        )
        .toBe('CLOSED');
    } finally {
      await purgeRoofingTrail(api, s.trail);
    }
  });
});
