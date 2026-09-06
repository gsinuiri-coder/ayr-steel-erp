import { expect, test } from '@playwright/test';
import { adminApi, adminCredentials, postJson } from '../helpers/api';
import { deactivateTrail, purgeProductionOrder, setupScenario } from '../helpers/production';

/**
 * Verificación puntual de D-121 (ajustes de alcance pedidos por el dueño sobre Fase 7e):
 *
 * a) `/bobinas` con pestañas (Disponibles/En corte/Agotadas/Todas) que mandan distintos
 *    query params al API, y el `<select>` de Estado que solo vive en "Todas".
 * b) el stat "Piezas teóricas" (derivado, sin cambio de backend) en la terminal de planta
 *    y en el detalle de una OP de drywall.
 *
 * No es cobertura de fase: es la comprobación mínima de que ambos ajustes quedaron
 * cableados de punta a punta.
 */

async function loginAsAdmin(page: import('@playwright/test').Page) {
  const { email, password } = adminCredentials();
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await expect(page).toHaveURL(/\/(cambiar-contrasena)?$/);
}

// La segunda prueba arma un escenario completo por API (compra, corte tercerizado,
// receta) y encima navega a dos rutas que el servidor de Next en modo dev (Turbopack)
// compila recién al primer visitante: el timeout default de 45 s no alcanza.
test.describe.configure({ timeout: 120_000 });

test.describe('D-121 — pestañas de bobinas y piezas teóricas en planta', () => {
  test('las pestañas de /bobinas filtran por status/availability y el select de Estado solo aparece en "Todas"', async ({
    page,
  }) => {
    await loginAsAdmin(page);

    const disponiblesRes = page.waitForResponse(
      (r) => r.url().includes('/api/coils?') && r.url().includes('availability=available'),
    );
    await page.goto('/bobinas');
    await expect(page.getByRole('heading', { name: 'Bobinas' })).toBeVisible();
    const disponibles = await disponiblesRes;
    const disponiblesParams = new URL(disponibles.url()).searchParams;
    expect(disponiblesParams.get('statusNe')).toBe('IN_THIRD_PARTY');
    expect(disponiblesParams.get('availability')).toBe('available');
    await expect(page.getByRole('tab', { name: 'Disponibles' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.getByText('No se pudieron cargar las bobinas.')).toHaveCount(0);
    await expect(page.getByRole('combobox', { name: 'Estado' })).toHaveCount(0);

    const enCorteRes = page.waitForResponse(
      (r) => r.url().includes('/api/coils?') && r.url().includes('status=IN_THIRD_PARTY'),
    );
    await page.getByRole('tab', { name: 'En corte' }).click();
    const enCorte = await enCorteRes;
    const enCorteParams = new URL(enCorte.url()).searchParams;
    expect(enCorteParams.get('status')).toBe('IN_THIRD_PARTY');
    expect(enCorteParams.get('statusNe')).toBeNull();
    expect(enCorteParams.get('availability')).toBeNull();
    await expect(page.getByText('No se pudieron cargar las bobinas.')).toHaveCount(0);
    await expect(page.getByRole('combobox', { name: 'Estado' })).toHaveCount(0);

    const agotadasRes = page.waitForResponse(
      (r) => r.url().includes('/api/coils?') && r.url().includes('availability=depleted'),
    );
    await page.getByRole('tab', { name: 'Agotadas' }).click();
    const agotadas = await agotadasRes;
    const agotadasParams = new URL(agotadas.url()).searchParams;
    expect(agotadasParams.get('statusNe')).toBe('IN_THIRD_PARTY');
    expect(agotadasParams.get('availability')).toBe('depleted');
    await expect(page.getByText('No se pudieron cargar las bobinas.')).toHaveCount(0);
    await expect(page.getByRole('combobox', { name: 'Estado' })).toHaveCount(0);

    const todasRes = page.waitForResponse((r) => r.url().includes('/api/coils?'));
    await page.getByRole('tab', { name: 'Todas' }).click();
    const todas = await todasRes;
    const todasParams = new URL(todas.url()).searchParams;
    expect(todasParams.get('statusNe')).toBeNull();
    expect(todasParams.get('availability')).toBeNull();
    await expect(page.getByText('No se pudieron cargar las bobinas.')).toHaveCount(0);
    await expect(page.getByRole('combobox', { name: 'Estado' })).toBeVisible();
  });

  test('una OP de drywall en curso muestra "Piezas teóricas" en /planta y en /produccion/[id]', async ({
    page,
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const scenario = await setupScenario(api);
    // 2400 kg montados / 2 kg por pieza (KG_PER_PIECE) = 1200.0 piezas teóricas exactas:
    // deja el valor esperado comprobable a ojo, sin redondeos raros.
    const order = await postJson<{ id: string; code: string }>(api, '/api/production', {
      productId: scenario.product.id,
    });
    await postJson(api, `/api/production/${order.id}/consume`, {
      coilId: scenario.strips[0]!.id,
    });

    try {
      await loginAsAdmin(page);

      await page.goto(`/planta?op=${order.id}`);
      await expect(page.getByRole('heading', { name: order.code })).toBeVisible();
      await expect(page.getByText('Piezas teóricas', { exact: true })).toBeVisible();
      await expect(page.getByText('1200.0', { exact: true })).toBeVisible();

      await page.goto(`/produccion/${order.id}`);
      await expect(page.getByRole('heading', { name: order.code })).toBeVisible();
      await expect(page.getByText('Piezas teóricas', { exact: true })).toBeVisible();
      await expect(page.getByText('1200.0', { exact: true })).toBeVisible();
      await expect(page.getByText('vs. 0 reportadas', { exact: false })).toBeVisible();
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
});
