import { expect, test } from '@playwright/test';
import { canonicalAccessorySku } from '@ayr/shared';
import { adminApi, createFinish, createUser, getJson, postJson } from '../helpers/api';
import { loginAndSetPassword, openSidebarGroup } from '../helpers/ui';
import { createColor } from '../helpers/roofing';

/**
 * M5 — editar un accesorio sin tocar espesor, color ni subtipo se guarda normal (D-343).
 *
 * Hasta esta corrección, el diálogo de producto mandaba **siempre** los campos estructurados
 * (espesor, ancho…) en el `PATCH` de edición, aunque no se hubieran tocado. El guardrail que
 * protege el SKU de un accesorio (`El SKU … refleja el espesor y el color…`) los compara contra
 * lo guardado, así que en la práctica cualquier edición —el nombre, el precio— rebotaba. El
 * arreglo es el mismo criterio que ya tenía el acabado desde F8-S5: solo se manda lo que cambió.
 */

const isProduction = !!process.env.E2E_BASE_URL;
test.skip(isProduction, 'Crea datos comerciales: nunca contra producción (D-126, regla dura 9).');
test.describe.configure({ timeout: 180_000 });

test.describe('M5 — editar un accesorio sin cambiar espesor, color ni subtipo', () => {
  test('el nombre y el precio se guardan sin error; cambiar el espesor rebota', async ({
    page,
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const color = await createColor(api);
    const finish = await createFinish(api, {
      businessLine: 'metallic-roofing',
      kind: 'PREPINTADO',
      colorId: color.id,
    });
    const line = (await getJson<{ id: string; code: string }[]>(api, '/api/business-lines')).find(
      (l) => l.code === 'metallic-roofing',
    );
    const sku = canonicalAccessorySku('0.30', color.code);
    const accessory = await postJson<{ id: string; sku: string }>(api, '/api/catalog', {
      businessLineId: line!.id,
      sku,
      name: 'Accesorio E2E M5',
      unit: 'MTR',
      source: 'MANUFACTURED',
      listPricePen: '30',
      finishId: finish.id,
      colorId: color.id,
      thicknessMm: '0.30',
      widthMm: '1220.00',
      roofingKind: 'ACCESORIO',
    });

    const admin = await createUser(api, 'ADMINISTRADOR');
    await loginAndSetPassword(page, admin, 'ClaveAdminE2E-2026');

    await openSidebarGroup(page, 'Catálogo');
    await page.getByRole('link', { name: 'Productos', exact: true }).click();
    await page.getByRole('tab', { name: 'Coberturas Aluzinc' }).click();
    // «Editar» es la acción principal de la fila (D-327): un botón visible, no el menú «⋯».
    const row = page.getByRole('row').filter({ hasText: sku });
    await row.getByRole('button', { name: 'Editar' }).click();
    const dialog = page.getByRole('dialog');

    // Solo el nombre y el precio: ni el espesor, ni el acabado, ni el subtipo se tocan.
    await dialog.getByLabel('Nombre').fill('Accesorio E2E M5 (editado)');
    await dialog.getByLabel('Precio de lista (S/, sin IGV)').fill('35');
    await dialog.getByRole('button', { name: 'Guardar cambios' }).click();
    await expect(dialog).toBeHidden();
    await expect(row).toContainText('Accesorio E2E M5 (editado)');

    // Ahora sí: cambiar el espesor rebota, porque el SKU lo refleja.
    await row.getByRole('button', { name: 'Editar' }).click();
    await dialog.getByLabel('Espesor (mm)').fill('0.45');
    await dialog.getByRole('button', { name: 'Guardar cambios' }).click();
    await expect(dialog.getByText(/refleja el espesor y el color/)).toBeVisible();
    await expect(dialog).toBeVisible();

    await api.patch(`/api/catalog/${accessory.id}`, { data: { isActive: false } });
  });
});
