import { expect, test } from '@playwright/test';
import { adminApi, createFinish, createUser, getJson } from '../helpers/api';
import { loginAndSetPassword, openSidebarGroup } from '../helpers/ui';
import {
  createCatalogProduct,
  deactivateTrail,
  setupScenario,
  type ProductDto,
  type StripOptionDto,
} from '../helpers/production';

/**
 * D-344 — drywall deja de usar receta: el espesor y el ancho del fleje son datos del SKU y el
 * acabado es siempre galvanizado. Aquí se prueba lo que ve el usuario y lo que sale del API:
 *
 * - el diálogo de producto pide el espesor del fleje y **avisa** (sin bloquear) cuando el
 *   kg/pieza se aleja más del 5 % del teórico — el caso de los marcadores 1.00 / 1.000;
 * - el catálogo trae ese aviso;
 * - los flejes que ofrece `/planta` salen del SKU (galvanizado, espesor y ancho exactos).
 *
 * Escribe catálogo, compras y corte: nunca contra producción (regla dura 9).
 */

const isProduction = !!process.env.E2E_BASE_URL;
test.skip(isProduction, 'Crea datos comerciales: nunca contra producción (D-126, regla dura 9).');
test.describe.configure({ timeout: 240_000 });

test.describe('D-344 — drywall sin receta', () => {
  test('el diálogo pide el espesor del fleje y avisa —sin bloquear— cuando el kg/pieza no cuadra', async ({
    page,
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    // De la densidad del acabado galvanizado sale el peso teórico del aviso.
    await createFinish(api, { businessLine: 'drywall', densityFactor: '7.85' });
    const admin = await createUser(api, 'ADMINISTRADOR');
    await loginAndSetPassword(page, admin, 'ClaveAdminE2E-2026');

    const sku = `E2E-D344${String(Date.now()).slice(-6)}`;
    await openSidebarGroup(page, 'Catálogo');
    await page.getByRole('link', { name: 'Productos', exact: true }).click();
    await page.getByRole('tab', { name: 'Drywall' }).click();
    await page.getByRole('button', { name: 'Nuevo producto' }).click();
    const dialog = page.getByRole('dialog');

    // No hay campo de acabado: drywall es siempre galvanizado.
    await expect(dialog.getByText('Espesor del fleje (mm)')).toBeVisible();
    await expect(dialog.getByText('Ancho del fleje — desarrollo (mm)')).toBeVisible();
    await expect(dialog.getByLabel('Acabado')).toBeHidden();

    await dialog.getByLabel('SKU').fill(sku);
    await dialog.getByLabel('Nombre').fill('Perfil E2E D-344');
    await dialog.getByLabel('Unidad').fill('NIU');

    // Marcadores como los de PERFILH / PERFILU: ancho 1.00 mm y 1.000 kg.
    await dialog.getByLabel('Espesor del fleje (mm)').fill('0.45');
    await dialog.getByLabel('Ancho del fleje — desarrollo (mm)').fill('1.00');
    await dialog.getByLabel('Largo de la pieza (mm)').fill('6000.00');
    await dialog.getByLabel('Peso de la pieza (kg)').fill('1.000');
    await expect(dialog.getByText(/Se aleja .* % del teórico/)).toBeVisible();

    // Con los datos reales de un OMEGA (fleje de 115 mm, 3 m, 1.220 kg) el aviso desaparece.
    await dialog.getByLabel('Ancho del fleje — desarrollo (mm)').fill('115.00');
    await dialog.getByLabel('Largo de la pieza (mm)').fill('3000.00');
    await dialog.getByLabel('Peso de la pieza (kg)').fill('1.220');
    await expect(dialog.getByText(/Se aleja .* % del teórico/)).toBeHidden();

    // Vuelve el marcador: el aviso no bloquea, el producto se guarda igual.
    await dialog.getByLabel('Peso de la pieza (kg)').fill('1.000');
    await expect(dialog.getByText(/Se aleja .* % del teórico/)).toBeVisible();
    await dialog.getByRole('button', { name: 'Crear producto' }).click();
    await expect(dialog).toBeHidden();

    // El catálogo lo lista con el mismo aviso.
    const row = page.getByRole('row').filter({ hasText: sku });
    await expect(row).toBeVisible();
    await expect(row).toContainText('fuera del teórico');

    const saved = (await getJson<ProductDto[]>(api, '/api/catalog')).find((p) => p.sku === sku);
    expect(saved).toMatchObject({
      thicknessMm: '0.45',
      widthMm: '115.00',
      pieceWeightKg: '1.000',
      finishId: null,
    });
    await api.patch(`/api/catalog/${saved!.id}`, { data: { isActive: false } });
  });

  test('el diálogo no deja guardar sin el espesor del fleje', async ({ page, baseURL }) => {
    const api = await adminApi(baseURL!);
    const admin = await createUser(api, 'ADMINISTRADOR');
    await loginAndSetPassword(page, admin, 'ClaveAdminE2E-2026');

    await openSidebarGroup(page, 'Catálogo');
    await page.getByRole('link', { name: 'Productos', exact: true }).click();
    await page.getByRole('tab', { name: 'Drywall' }).click();
    await page.getByRole('button', { name: 'Nuevo producto' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('SKU').fill(`E2E-D344${String(Date.now()).slice(-6)}`);
    await dialog.getByLabel('Nombre').fill('Perfil E2E sin espesor');
    await dialog.getByLabel('Unidad').fill('NIU');
    await dialog.getByLabel('Ancho del fleje — desarrollo (mm)').fill('115.00');
    await dialog.getByLabel('Largo de la pieza (mm)').fill('3000.00');
    await dialog.getByLabel('Peso de la pieza (kg)').fill('1.220');
    await dialog.getByRole('button', { name: 'Crear producto' }).click();

    // El API rechaza y el diálogo sigue abierto diciendo qué falta.
    await expect(dialog.getByText('El espesor del fleje es obligatorio en Drywall')).toBeVisible();
    await expect(dialog).toBeVisible();
  });

  test('los flejes que ofrece planta salen del SKU: galvanizado, espesor y ancho exactos', async ({
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const scenario = await setupScenario(api);
    const extra: string[] = [];
    try {
      // El perfil del escenario pide el fleje que hay (0.50 × 600): planta ve los dos flejes.
      const options = await getJson<StripOptionDto[]>(
        api,
        `/api/production/strips?productId=${scenario.product.id}`,
      );
      expect(options.map((o) => o.coilId).sort()).toEqual(scenario.strips.map((s) => s.id).sort());
      expect(options[0]).toMatchObject({
        widthMm: '600.00',
        thicknessMm: '0.50',
        estimatedPieces: 1200,
      });

      // Un perfil cuyo SKU pide otro ancho de fleje: ninguno sirve.
      const wider = await createCatalogProduct(api, { pieceWeightKg: '2.000', widthMm: '700' });
      extra.push(wider.id);
      expect(
        await getJson<StripOptionDto[]>(api, `/api/production/strips?productId=${wider.id}`),
      ).toEqual([]);

      // Y uno que pide otro espesor tampoco: el espesor es exacto, sin tolerancia.
      const thinner = await createCatalogProduct(api, {
        pieceWeightKg: '2.000',
        thicknessMm: '0.51',
      });
      extra.push(thinner.id);
      expect(
        await getJson<StripOptionDto[]>(api, `/api/production/strips?productId=${thinner.id}`),
      ).toEqual([]);
    } finally {
      await deactivateTrail(api, {
        cuttingOrderId: scenario.cuttingOrderId,
        motherId: scenario.mother.id,
        purchaseId: scenario.purchaseId,
        supplierId: scenario.supplier.id,
        finish: scenario.finish,
        productIds: [scenario.product.id, ...extra],
      });
    }
  });
});
