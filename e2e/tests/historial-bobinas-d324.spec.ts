import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { adminApi, adminCredentials } from '../helpers/api';
import { createCustomer } from '../helpers/sales';
import {
  mountCoil,
  pieces,
  purgeRoofingTrail,
  quoteAndOrder,
  reportPieces,
  setupRoofingScenario,
} from '../helpers/roofing';

/**
 * D-324 (correcciones 04, M2): la lista de bobinas de una orden en el historial de `/planta` no
 * puede ensanchar la página. Un pedido con muchas bobinas activaba el scroll horizontal de toda la
 * pantalla; ahora la fila muestra dos códigos y un «+N» con el resto en un popover, y la tabla
 * tiene su propio contenedor.
 *
 * Las bobinas «de más» se inyectan en la respuesta de `GET /production/:id` (una orden real, con
 * su bobina real): armar 30 bobinas montadas costaría minutos y no cambia lo que se mide, que es
 * el ancho de la página con esa lista larga.
 */
const isProduction = !!process.env.E2E_BASE_URL;
test.skip(isProduction, 'Crea compras, bobinas y pedidos: nunca contra producción (D-126).');
test.describe.configure({ timeout: 240_000 });

async function loginAsAdmin(page: Page): Promise<void> {
  const { email, password } = adminCredentials();
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await expect(page).toHaveURL(/\/(cambiar-contrasena)?$/, { timeout: 60_000 });
}

test('historial: con más de 10 bobinas la fila muestra dos y «+N», y la página no se ensancha', async ({
  page,
  baseURL,
}) => {
  const api = await adminApi(baseURL!);
  const scenario = await setupRoofingScenario(api, { weightKg: '2000' });
  const customer = await createCustomer(api);
  const trail: Parameters<typeof purgeRoofingTrail>[1] = {
    supplierId: scenario.supplier.id,
    finishId: scenario.finish.id,
    colorId: scenario.color.id,
    productIds: [scenario.product.id],
    coilIds: [scenario.coil.id],
    purchaseIds: [scenario.purchaseId],
    orderIds: [],
    quotationIds: [],
  };
  try {
    const { quotation, order } = await quoteAndOrder(api, {
      customerId: customer.id,
      productId: scenario.product.id,
      rows: pieces([4, 3]),
    });
    trail.quotationIds = [quotation.id];
    trail.orderIds = [order.id];
    const opId = order.reservations[0]!.productionOrderId!;
    await mountCoil(api, opId, { coilId: scenario.coil.id });
    await reportPieces(api, opId, { pieces: pieces([4, 2]) });

    // 30 bobinas más en el reporte de esa orden, con códigos tan largos como los reales.
    const extra = Array.from({ length: 30 }, (_, i) => ({
      id: randomUUID(),
      code: `IMPO-ALZ-ROJO-3020-0.38-4194-${String(i + 10)}`,
      kg: '12.500',
    }));
    await page.route(`**/api/production/${opId}`, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const response = await route.fetch();
      const body = (await response.json()) as { reports: { coils: unknown[] }[] };
      body.reports[0]!.coils = [...body.reports[0]!.coils, ...extra];
      return route.fulfill({ response, json: body });
    });

    await page.setViewportSize({ width: 1366, height: 768 });
    await loginAsAdmin(page);
    await page.goto('/planta?historial=1');
    const historyRow = page
      .getByTestId('history-order-row')
      .filter({ has: page.getByRole('link', { name: order.code, exact: true }) });
    await expect(historyRow).toHaveCount(1, { timeout: 60_000 });
    await historyRow.getByRole('button', { name: /Ver las órdenes de/ }).click();

    const used = page.getByTestId('used-coils');
    await expect(used).toBeVisible({ timeout: 30_000 });
    // Dos códigos a la vista y el resto detrás de «+N» (la bobina real más 30 inyectadas = 31).
    await expect(used.getByRole('link')).toHaveCount(2);
    await expect(used.getByRole('button', { name: 'Ver las 29 bobinas restantes' })).toContainText(
      '+29',
    );

    // La página no crece por la fila: ni el documento ni el cuerpo desbordan el ancho de la ventana.
    const widths = await page.evaluate(() => ({
      inner: window.innerWidth,
      doc: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
    }));
    expect(widths.doc).toBe(widths.inner);
    expect(widths.body).toBeLessThanOrEqual(widths.inner);

    // El popover lista las que no caben, con su enlace y sus kilos.
    await used.getByRole('button', { name: /bobinas restantes/ }).click();
    const more = page.getByTestId('used-coils-more');
    await expect(more.getByRole('link')).toHaveCount(29);
    await expect(more).toContainText('12.500');
  } finally {
    await purgeRoofingTrail(api, trail);
    await api.dispose();
  }
});
