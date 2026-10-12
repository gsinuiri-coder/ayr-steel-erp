import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { adminApi, adminCredentials, postJson } from '../helpers/api';
import { deactivateTrail, setupScenario, type ProductionOrderDto } from '../helpers/production';

/**
 * cc49 (D-637): «Historial» en el detalle de compra, de orden de corte y de orden de producción,
 * al lado de las acciones como en los demás detalles (D-635). Abre la auditoría filtrada por ese
 * documento, con los 12 meses por defecto, y la lista trae sus registros.
 *
 * Escribe compras, corte y producción: nunca contra producción (D-126).
 */
const isProduction = !!process.env.E2E_BASE_URL;
test.skip(isProduction, 'Escribe compras, corte y producción: nunca contra producción (D-126).');
test.describe.configure({ timeout: 180_000 });

let api: APIRequestContext;

test.beforeAll(async ({ baseURL }) => {
  api = await adminApi(baseURL!);
});

async function loginAsAdmin(page: Page): Promise<void> {
  const { email, password } = adminCredentials();
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await expect(page).toHaveURL(/\/(cambiar-contrasena)?$/, { timeout: 60_000 });
}

/** Desde el detalle, «Historial» lleva a la auditoría de ese documento y la fila está. */
async function openHistory(
  page: Page,
  detailPath: string,
  entityType: string,
  entityId: string,
  rowText: string,
): Promise<void> {
  await page.goto(detailPath);
  const link = page.getByRole('link', { name: 'Historial' });
  await expect(link).toBeVisible({ timeout: 30_000 });
  await expect(link).toHaveAttribute(
    'href',
    `/auditoria?entityType=${entityType}&entityId=${entityId}`,
  );
  await link.click();
  await expect(page).toHaveURL(new RegExp(`/auditoria\\?entityType=${entityType}&entityId=`));
  await expect(page.getByTestId('filtro-documento')).toBeVisible();
  await expect(page.getByText('Últimos 12 meses')).toBeVisible();
  await expect(page.getByTestId('fila-auditoria').filter({ hasText: rowText }).first()).toBeVisible(
    { timeout: 15_000 },
  );
}

test('«Historial» en compra, corte y orden de producción abre su auditoría (D-637)', async ({
  page,
}) => {
  const scenario = await setupScenario(api);
  const op = await postJson<ProductionOrderDto>(api, '/api/production', {
    productId: scenario.product.id,
  });

  try {
    await loginAsAdmin(page);

    await openHistory(
      page,
      `/compras/${scenario.purchaseId}`,
      'purchases',
      scenario.purchaseId,
      'Recepción de compra',
    );
    await openHistory(
      page,
      `/corte/${scenario.cuttingOrderId}`,
      'cutting_orders',
      scenario.cuttingOrderId,
      'Recepción de corte',
    );
    await openHistory(
      page,
      `/produccion/${op.id}`,
      'production_orders',
      op.id,
      'Orden de producción creada',
    );
  } finally {
    await deactivateTrail(api, {
      productionOrderIds: [op.id],
      cuttingOrderId: scenario.cuttingOrderId,
      motherId: scenario.mother.id,
      purchaseId: scenario.purchaseId,
      supplierId: scenario.supplier.id,
      finish: scenario.finish,
      productId: scenario.product.id,
    });
  }
});
