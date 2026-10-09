import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { adminApi, adminCredentials, getJson, postJson } from '../helpers/api';
import { balanceOf, movementsOf, type ProductionOrderDto } from '../helpers/production';
import { createCustomer } from '../helpers/sales';
import {
  buyRoofingCoil,
  mountCoil,
  pieces,
  purgeRoofingTrail,
  quoteAndOrderLines,
  setupRoofingScenario,
} from '../helpers/roofing';
import { openQueuedOrder } from '../helpers/ui';

/**
 * cc35 (ESPEC §1) — producir una OP con el modelo M: un bloque por bobina, en el orden en que se
 * montaron, guardado solo en el borrador de la orden.
 *
 * Aritmética a mano: 1 000 mm × 0.50 mm, densidad 8.0 y el 1 % de D-165 ⇒ 4.04 kg por metro.
 * Plan: 10 × 4 m = 40 m = 161.6 kg.
 */
const allowWrites = !process.env.E2E_BASE_URL;
test.skip(!allowWrites, 'Crea compras, bobinas y producción: nunca contra producción (D-126).');
test.describe.configure({ timeout: 300_000 });

async function loginAsAdmin(page: Page): Promise<void> {
  const { email, password } = adminCredentials();
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await expect(page).toHaveURL(/\/(cambiar-contrasena)?$/, { timeout: 60_000 });
}

interface Setup {
  first: { id: string; code: string };
  second: { id: string; code: string };
  orderId: string;
  opId: string;
  opCode: string;
  trail: Parameters<typeof purgeRoofingTrail>[1];
}

/** Dos bobinas montadas en llamadas separadas (el orden de montaje sale de `createdAt`). */
async function setup(
  api: APIRequestContext,
  options: { firstKg: string; secondKg: string; rows?: ReturnType<typeof pieces> },
): Promise<Setup> {
  const scenario = await setupRoofingScenario(api, { weightKg: options.firstKg });
  const second = await buyRoofingCoil(api, {
    supplierId: scenario.supplier.id,
    finishId: scenario.finish.id,
    colorId: scenario.color.id,
    weightKg: options.secondKg,
  });
  const customer = await createCustomer(api);
  const { quotation, order } = await quoteAndOrderLines(api, {
    customerId: customer.id,
    lines: [{ productId: scenario.product.id, rows: options.rows ?? pieces([4, 10]) }],
  });
  const opId = order.reservations[0]!.productionOrderId!;
  await mountCoil(api, opId, { coilId: scenario.coil.id });
  await mountCoil(api, opId, { coilId: second.coil.id });
  const op = await getJson<ProductionOrderDto>(api, `/api/production/${opId}`);
  return {
    first: { id: scenario.coil.id, code: scenario.coil.code },
    second: { id: second.coil.id, code: second.coil.code },
    orderId: order.id,
    opId,
    opCode: op.code,
    trail: {
      supplierId: scenario.supplier.id,
      finishId: scenario.finish.id,
      colorId: scenario.color.id,
      productIds: [scenario.product.id],
      coilIds: [scenario.coil.id, second.coil.id],
      purchaseIds: [scenario.purchaseId, second.purchaseId],
      productionOrderIds: [opId],
      orderIds: [order.id],
      quotationIds: [quotation.id],
    },
  };
}

async function openOrder(page: Page, s: Setup): Promise<Locator> {
  await loginAsAdmin(page);
  await page.goto(`/planta?pedido=${s.orderId}`);
  await openQueuedOrder(page, s.opCode);
  const panel = page.locator(`#panel-${s.opId}`);
  await expect(panel.getByText('Plan y avance')).toBeVisible({ timeout: 60_000 });
  return panel;
}

const block = (panel: Locator, code: string) => panel.getByTestId(`bloque-${code}`);

async function waitSaved(panel: Locator): Promise<void> {
  await expect(panel.getByText('Todo lo escrito está guardado')).toBeVisible({ timeout: 30_000 });
}

test.describe('cc35 — modelo M, bobina por bobina', () => {
  let api: APIRequestContext;
  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
  });
  test.afterAll(async () => {
    await api.dispose();
  });

  test('el último bloque se llena con lo que falta y un refresco no pierde lo escrito', async ({
    page,
  }) => {
    const s = await setup(api, { firstKg: '2000', secondKg: '2000' });
    try {
      const panel = await openOrder(page, s);
      const a = block(panel, s.first.code);
      const b = block(panel, s.second.code);

      // Sin nada escrito, la segunda (la última montada) lleva todo lo que falta.
      await expect(b.getByText(/Llenada sola con lo que faltaba/)).toBeVisible();
      await expect(b.getByLabel(/Largo del corte 1 de/)).toHaveValue('4.00');
      await expect(b.getByLabel(/Planchas del corte 1 de/)).toHaveValue('10');
      await expect(panel.getByTestId('cuadre-plan')).toContainText('10 de 10 planchas');

      // De la primera salieron 4: la segunda se llena con las 6 que faltan.
      await a.getByLabel(/Largo del corte 1 de/).selectOption('4.00');
      await a.getByLabel(/Planchas del corte 1 de/).fill('4');
      await expect(b.getByLabel(/Planchas del corte 1 de/)).toHaveValue('6');
      await a.getByLabel(/kg consumidos de/).fill('18');
      await waitSaved(panel);

      // Un refresco a mitad de la carga no pierde lo escrito: vive en el borrador.
      await page.reload();
      await openQueuedOrder(page, s.opCode);
      const again = page.locator(`#panel-${s.opId}`);
      const a2 = block(again, s.first.code);
      await expect(a2.getByLabel(/Planchas del corte 1 de/)).toHaveValue('4', { timeout: 60_000 });
      await expect(a2.getByLabel(/kg consumidos de/)).toHaveValue('18.000');
      await expect(block(again, s.second.code).getByLabel(/Planchas del corte 1 de/)).toHaveValue(
        '6',
      );
      // Nada se movió todavía: el borrador no toca el kardex.
      expect((await balanceOf(api, 'COIL', s.first.id)).qty).toBe('2000.000');
    } finally {
      await purgeRoofingTrail(api, s.trail);
    }
  });

  test('«Registrar y cerrar» muestra «Qué va a pasar»: el despunte de cada bloque cae en su bobina', async ({
    page,
  }) => {
    const s = await setup(api, { firstKg: '2000', secondKg: '2000' });
    try {
      const panel = await openOrder(page, s);
      const a = block(panel, s.first.code);
      // Bobina 1: 4 × 4 m = 64.64 kg teóricos, declara 70 → 5.36 kg de despunte en ella.
      await a.getByLabel(/Largo del corte 1 de/).selectOption('4.00');
      await a.getByLabel(/Planchas del corte 1 de/).fill('4');
      await a.getByLabel(/kg consumidos de/).fill('70');
      await expect(a.getByText('Despunte 5.360 kg')).toBeVisible();
      await waitSaved(panel);

      await panel.getByRole('button', { name: `Registrar y cerrar ${s.opCode}` }).click();
      const preview = panel.getByTestId('que-va-a-pasar');
      await expect(preview).toContainText(`5.360 kg de ${s.first.code}`, { timeout: 60_000 });
      await expect(preview).toContainText(`${s.opCode} queda cerrada`);
      // Lo de la vista previa no escribió nada.
      expect((await balanceOf(api, 'COIL', s.first.id)).qty).toBe('2000.000');

      await preview.getByRole('button', { name: 'Confirmar: registrar y cerrar' }).click();
      await expect
        .poll(
          async () => (await getJson<ProductionOrderDto>(api, `/api/production/${s.opId}`)).status,
          { timeout: 60_000 },
        )
        .toBe('CLOSED');
      // Bobina 1: 64.64 + 5.36 = 70 kg. Bobina 2: 6 × 4 m = 96.96 kg, sin despunte.
      expect((await balanceOf(api, 'COIL', s.first.id)).qty).toBe('1930.000');
      expect((await balanceOf(api, 'COIL', s.second.id)).qty).toBe('1903.040');
      const scrapB = (await movementsOf(api, 'COIL', s.second.id)).filter(
        (m) => m.refType === 'SCRAP',
      );
      expect(scrapB).toHaveLength(0);
    } finally {
      await purgeRoofingTrail(api, s.trail);
    }
  });

  test('un error del registro se muestra en el bloque de su bobina', async ({ page }) => {
    const s = await setup(api, { firstKg: '2000', secondKg: '2000' });
    try {
      const panel = await openOrder(page, s);
      const a = block(panel, s.first.code);
      await a.getByLabel(/Largo del corte 1 de/).selectOption('4.00');
      await a.getByLabel(/Planchas del corte 1 de/).fill('4');
      await waitSaved(panel);

      // Por debajo cambia el estado: un reporte directo de 1 × 4 m deja sin lugar al último bloque.
      await postJson(api, `/api/production/roofing/${s.opId}/report`, {
        coilId: s.first.id,
        pieces: pieces([4, 1]),
      });
      await panel.getByRole('button', { name: `Registrar producción de ${s.opCode}` }).click();
      const b = block(panel, s.second.code);
      await expect(b.getByRole('alert')).toContainText(/plan/, { timeout: 60_000 });
      await expect(a.getByRole('alert')).toHaveCount(0);
    } finally {
      await purgeRoofingTrail(api, s.trail);
    }
  });

  test('pasado el 1 % de lo montado, la casilla con motivo aparece en el bloque afectado', async ({
    page,
  }) => {
    // Bobina 2 de 150 kg: los 161.6 kg del plan no entran (más del 5 %).
    const s = await setup(api, { firstKg: '2000', secondKg: '150' });
    try {
      const panel = await openOrder(page, s);
      const b = block(panel, s.second.code);
      await expect(b.getByTestId('tolerance-override')).toBeVisible();
      await expect(block(panel, s.first.code).getByTestId('tolerance-override')).toHaveCount(0);

      // Sin la casilla no se registra; con ella, sí.
      await panel.getByRole('button', { name: `Registrar producción de ${s.opCode}` }).click();
      await b.getByRole('checkbox', { name: /Confirmar la bobina 2/ }).check();
      await b.getByRole('combobox', { name: /Motivo de la bobina 2/ }).selectOption('LIGHTER_COIL');
      await panel.getByRole('button', { name: `Registrar producción de ${s.opCode}` }).click();
      await expect
        .poll(async () => (await balanceOf(api, 'COIL', s.second.id)).qty, { timeout: 60_000 })
        .toBe('0.000');
    } finally {
      await purgeRoofingTrail(api, s.trail);
    }
  });
});
