import { expect, test } from '@playwright/test';
import { businessToday } from '@ayr/shared';
import { adminApi, createSupplier, createUser, getJson, postJson } from '../helpers/api';
import { loginAndSetPassword } from '../helpers/ui';
import { createSellableProduct } from '../helpers/sales';

/**
 * D-353 — «Recibir seleccionadas» en /compras: varias compras en borrador, cada una por su propio
 * `receive()`, con el resultado de cada una. No cambia ninguna regla de la recepción.
 */

test.skip(!!process.env.E2E_BASE_URL, 'Crea compras: nunca contra producción (D-126).');
test.describe.configure({ timeout: 180_000 });

test('D-353 — recibir dos compras en borrador de una vez', async ({ page, baseURL }) => {
  const api = await adminApi(baseURL!);
  const supplier = await createSupplier(api);
  const product = await createSellableProduct(api, { lineCode: 'trading' });
  // Empieza en 9: un número que empieza con 0 se guarda sin el cero (D-538).
  const n = `9${String(Date.now()).slice(-6)}`;
  const purchase = (number: string) =>
    postJson<{ id: string }>(api, '/api/purchases', {
      supplierId: supplier.id,
      businessLine: 'trading',
      type: 'FINISHED_GOOD',
      docType: 'FACTURA',
      series: 'F777',
      number,
      issueDate: businessToday(),
      currency: 'PEN',
      paymentTerms: 'CONTADO',
      items: [
        { productId: product.id, description: product.name, qty: '2', unit: 'NIU', unitPrice: '5' },
      ],
    });
  const a = await purchase(`${n}1`);
  const b = await purchase(`${n}2`);

  const admin = await createUser(api, 'ADMINISTRADOR');
  await loginAndSetPassword(page, admin, 'ClaveAdminE2E-2026');
  await page.goto(`/compras?search=${n}`);
  await page.getByLabel(`Seleccionar F777-${n}1 para recibir`).check();
  await page.getByLabel(`Seleccionar F777-${n}2 para recibir`).check();
  await page.getByRole('button', { name: 'Recibir seleccionadas (2)' }).click();
  await expect(page.getByText('2 recibidas.')).toBeVisible({ timeout: 60_000 });

  for (const p of [a, b]) {
    expect((await getJson<{ status: string }>(api, `/api/purchases/${p.id}`)).status).toBe(
      'RECEIVED',
    );
  }
  // Recibidas, ya no se ofrecen para recibir.
  await expect(page.getByLabel(`Seleccionar F777-${n}1 para recibir`)).toHaveCount(0);
});
