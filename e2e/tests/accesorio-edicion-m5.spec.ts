import { expect, test } from '@playwright/test';
import { canonicalAccessorySku } from '@ayr/shared';
import { adminApi, createFinish, createUser, getJson, postJson } from '../helpers/api';
import { loginAndSetPassword, openSidebarGroup } from '../helpers/ui';
import { createColor, purgeRoofingTrail, setupRoofingScenario } from '../helpers/roofing';
import { createCustomer, type QuotationDto } from '../helpers/sales';
import { today } from '../helpers/production';

/**
 * M5 — editar un accesorio sin tocar espesor, color ni subtipo se guarda normal (D-343).
 *
 * Hasta esta corrección, el diálogo de producto mandaba **siempre** los campos estructurados
 * (espesor, ancho…) en el `PATCH` de edición, aunque no se hubieran tocado. El arreglo es el
 * mismo criterio que ya tenía el acabado desde F8-S5: solo se manda lo que cambió.
 *
 * D-348 — sin uso real (las cotizaciones anuladas o vencidas no cuentan), el espesor, el color y
 * el subtipo de un accesorio **sí** cambian, junto con el SKU que los refleja. Con uso real, el
 * diálogo los bloquea y dice qué lo usa.
 */

const isProduction = !!process.env.E2E_BASE_URL;
test.skip(isProduction, 'Crea datos comerciales: nunca contra producción (D-126, regla dura 9).');
test.describe.configure({ timeout: 180_000 });

test.describe('M5 — editar un accesorio sin cambiar espesor, color ni subtipo', () => {
  test('el nombre y el precio se guardan sin error; sin uso, el espesor cambia con su SKU', async ({
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

    // D-348: sin uso real, el espesor cambia y el SKU se vuelve a formar solo.
    const newSku = canonicalAccessorySku('0.45', color.code);
    await row.getByRole('button', { name: 'Editar' }).click();
    await dialog.getByLabel('Espesor (mm)').fill('0.45');
    await expect(dialog.getByLabel('SKU')).toHaveValue(newSku);
    await dialog.getByRole('button', { name: 'Guardar cambios' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('row').filter({ hasText: newSku })).toBeVisible();

    await api.patch(`/api/catalog/${accessory.id}`, { data: { isActive: false } });
  });
});

test.describe('D-348 — anular la cotización libera la estructura del accesorio', () => {
  test('con cotización viva el diálogo bloquea; anulada, el subtipo cambia desde el diálogo', async ({
    page,
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const s = await setupRoofingScenario(api, { weightKg: '1000' });
    const customer = await createCustomer(api);
    const trail = {
      supplierId: s.supplier.id,
      finishId: s.finish.id,
      colorId: s.color.id,
      productIds: [s.product.id],
      coilIds: [s.coil.id],
      purchaseIds: [s.purchaseId],
      quotationIds: [] as string[],
    };
    try {
      const sku = canonicalAccessorySku(s.product.thicknessMm ?? '0.50', s.color.code);
      const accessory = await postJson<{ id: string }>(api, '/api/catalog', {
        businessLineId: s.product.businessLineId,
        sku,
        name: 'Accesorio E2E D-348',
        unit: 'MTR',
        source: 'MANUFACTURED',
        listPricePen: '30',
        finishId: s.product.finishId,
        colorId: s.product.colorId,
        thicknessMm: s.product.thicknessMm,
        widthMm: s.product.widthMm,
        roofingKind: 'ACCESORIO',
      });
      trail.productIds.push(accessory.id);
      const quotation = await postJson<QuotationDto>(api, '/api/sales/quotations', {
        customerId: customer.id,
        issueDate: today(),
        items: [{ productId: accessory.id, qty: '10.000', unitPricePen: '60' }],
      });
      trail.quotationIds.push(quotation.id);

      const admin = await createUser(api, 'ADMINISTRADOR');
      await loginAndSetPassword(page, admin, 'ClaveAdminE2E-2026');
      await openSidebarGroup(page, 'Catálogo');
      await page.getByRole('link', { name: 'Productos', exact: true }).click();
      await page.getByRole('tab', { name: 'Coberturas Aluzinc' }).click();
      const row = page.getByRole('row').filter({ hasText: sku });
      const dialog = page.getByRole('dialog');

      // Con la cotización viva: subtipo y espesor bloqueados, y el motivo a la vista.
      await row.getByRole('button', { name: 'Editar' }).click();
      await expect(dialog.getByTestId('structure-lock-reason')).toContainText(
        'cotizaciones vigentes',
      );
      await expect(dialog.getByLabel('Espesor (mm)')).toBeDisabled();
      await dialog.getByRole('button', { name: 'Cancelar' }).click();

      // Anulada la cotización, el producto deja de tener uso real.
      await postJson(api, `/api/sales/quotations/${quotation.id}/cancel`, {
        reason: 'Prueba E2E de D-348',
      });
      await page.reload();
      await page.getByRole('tab', { name: 'Coberturas Aluzinc' }).click();
      await row.getByRole('button', { name: 'Editar' }).click();
      await expect(dialog.getByTestId('structure-lock-reason')).toBeHidden();

      // Pasa a «a medida»: el SKU ACCES… ya no le sirve y se escribe uno nuevo en el mismo guardado.
      await dialog.getByRole('combobox', { name: 'Subtipo de cobertura' }).click();
      await page.getByRole('option', { name: /medida/i }).click();
      await dialog.getByRole('button', { name: 'Guardar cambios' }).click();
      await expect(dialog.getByText(/Los SKU ACCES… son de accesorios/).first()).toBeVisible();
      const newSku = `E2EMED${Date.now().toString(36).toUpperCase()}`;
      await dialog.getByLabel('SKU').fill(newSku);
      await dialog.getByRole('button', { name: 'Guardar cambios' }).click();
      await expect(dialog).toBeHidden();
      const saved = await getJson<{ sku: string; roofingKind: string }>(
        api,
        `/api/catalog/${accessory.id}`,
      );
      expect(saved).toMatchObject({ sku: newSku, roofingKind: 'A_MEDIDA' });
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });
});
